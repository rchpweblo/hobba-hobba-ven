'use strict';

// Bizarre Bazaar fork: catching up a Discord channel imported before. A read
// with `after` fetches only the messages after that id, page by page, and
// writing them adds only those, with a forum post's first new reply kept as a
// reply. Every Discord id here is made up.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-catchup-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const auth = require('../src/auth');
auth.verifyToken = (token) => (token === 'admin' ? { id: 1 } : null);
const { initDatabase } = require('../src/database');
const db = initDatabase();
db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (1, 'admin', 'x', 1)").run();

// Ferry itself is not needed, only the headers it hands the import.
const ferryPath = require.resolve('../src/ferry');
require.cache[ferryPath] = { id: ferryPath, filename: ferryPath, loaded: true, exports: { importHeaders: () => ({ Authorization: 'Bot test' }) } };
const registerImport = require('../src/routes/import');

const routes = {};
const app = {
  post: (p, ...fns) => { routes['POST ' + p] = fns[fns.length - 1]; },
  get: (p, ...fns) => { routes['GET ' + p] = fns[fns.length - 1]; },
};
registerImport({ app, uploadDiskGuard: (q, s, n) => n(), uploadLimiter: (q, s, n) => n(), importUpload: {}, verifyAdminFromDb: () => true });

const call = (key, req) => new Promise((resolve) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
  routes[key](req, res);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function job(kind, started) {
  for (let i = 0; i < 500; i++) {
    const r = await call(`GET /api/import/discord/${kind}/:jobId`, { headers: { authorization: 'Bearer admin' }, params: { jobId: started.body.jobId } });
    if (r.body.state === 'done') return r;
    await sleep(10);
  }
  return null;
}

test.after(() => {
  db.close();
  fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true });
  // The import routes keep a cleanup timer running; as in importExecuteJob.test.js.
  setImmediate(() => process.exit(0));
});

const CHAT = '920000000000000010';
const POST = '920000000000000020';   // a forum post: a thread with the post's id
const FORUM = '920000000000000030';
// Message ids in order; id(n) sorts as numbers do.
const id = (n) => String(930000000000000000n + BigInt(n));
const at = (n) => new Date(Date.UTC(2026, 9, 29, 0, 0, n)).toISOString();
const msg = (n, content) => ({ id: id(n), type: 0, content, timestamp: at(n), author: { id: '940000000000000001', username: 'someone' } });

// 250 messages in the chat channel. Discord lists a page newest first, and
// `after` gives the 100 just after that id.
const chatMessages = Array.from({ length: 250 }, (_, i) => msg(i, `chat ${i}`));
const postReplies = [msg(1000, 'old reply'), msg(1001, 'new reply 1'), msg(1002, 'new reply 2')];
const requested = [];
global.fetch = async (url) => {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/api\/v10/, '');
  requested.push(p + u.search);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const page = (list) => {
    const after = u.searchParams.get('after');
    const limit = Number(u.searchParams.get('limit')) || 50;
    const newer = list.filter(m => !after || BigInt(m.id) > BigInt(after));
    return json(newer.slice(0, limit).reverse());
  };
  if (p === `/channels/${CHAT}/messages`) return page(chatMessages);
  if (p === `/channels/${POST}/messages`) return page(postReplies);
  return json({ message: 'Unknown' }, 404);
};

test('a read with `after` fetches only what came after it, across pages', async () => {
  const started = await call('POST /api/import/discord/fetch', {
    headers: { authorization: 'Bearer admin' },
    body: { useFerry: true, channels: [{ id: CHAT, name: 'chat', after: id(39) }] },
  });
  assert.equal(started.status, 202);
  const done = await job('fetch', started);
  assert.equal(done.status, 200);
  assert.equal(done.body.totalMessages, 210, 'messages 40 to 249');
  const reads = requested.filter(r => r.startsWith(`/channels/${CHAT}/messages`));
  assert.deepEqual(reads.map(r => new URL('http://x' + r).searchParams.get('after')), [id(39), id(139), id(239)],
    'each page goes on from the newest id of the one before');
  const data = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `haven-import-${done.body.importId}.json`), 'utf8'));
  const ids = data.channels[0].messages.map(m => m.discordId);
  assert.equal(new Set(ids).size, 210);
  assert.ok(!ids.includes(id(39)) && ids.includes(id(40)) && ids.includes(id(249)));
  fs.rmSync(path.join(os.tmpdir(), `haven-import-${done.body.importId}.json`), { force: true });
});

test('catching up a forum post keeps its first new reply as a reply', async () => {
  // The forum and its post, as the first import left them.
  const forumId = db.prepare("INSERT INTO channels (name, code, created_by, discord_channel_id, is_forum) VALUES ('ideas', 'bbbb0001', 1, ?, 1)").run(FORUM).lastInsertRowid;
  const topic = db.prepare("INSERT INTO messages (channel_id, content, imported_from, discord_message_id, title) VALUES (?, 'the post', 'discord', ?, 'A post')").run(forumId, POST).lastInsertRowid;
  db.prepare("INSERT INTO messages (channel_id, content, imported_from, discord_message_id, thread_id) VALUES (?, 'old reply', 'discord', ?, ?)").run(forumId, id(1000), topic);

  const started = await call('POST /api/import/discord/fetch', {
    headers: { authorization: 'Bearer admin' },
    body: { useFerry: true, channels: [{ id: POST, name: 'A post', kind: 'thread', parentId: FORUM, after: id(1000) }] },
  });
  const read = await job('fetch', started);
  assert.equal(read.body.totalMessages, 2);

  const written = await call('POST /api/import/discord/execute', {
    headers: { authorization: 'Bearer admin' },
    body: { importId: read.body.importId, copyFiles: false, selectedChannels: [{ discordId: POST, originalName: 'A post', name: 'A post' }] },
  });
  const done = await job('execute', written);
  assert.equal(done.body.success, true);
  assert.equal(done.body.channelsCreated, 0);
  const replies = db.prepare('SELECT content FROM messages WHERE thread_id = ? ORDER BY id').all(topic).map(m => m.content);
  assert.deepEqual(replies, ['old reply', 'new reply 1', 'new reply 2']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND thread_id IS NULL').get(forumId).n, 1, 'no second topic');
});
