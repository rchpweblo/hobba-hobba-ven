'use strict';

// Bizarre Bazaar fork: a Discord thread whose own id is linked to a Haven
// channel (a sub-channel made for it) is imported into that channel as
// ordinary messages. Any other thread still becomes a Haven thread inside
// its parent channel.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-bazaarthread-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const auth = require('../src/auth');
auth.verifyToken = (token) => (token === 'admin' ? { id: 1 } : null);
const { initDatabase } = require('../src/database');
const db = initDatabase();
db.prepare("INSERT INTO users (id, username, password_hash, is_admin) VALUES (1, 'admin', 'x', 1)").run();
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

test.after(() => {
  db.close();
  fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true });
  // The import routes keep a cleanup timer running; as in importExecuteJob.test.js.
  setImmediate(() => process.exit(0));
});

test('a thread with a sub-channel of its own is imported into it; other threads stay threads', async () => {
  // The layout as the server template and the channel links leave it.
  const add = db.prepare('INSERT INTO channels (name, code, created_by, discord_channel_id, parent_channel_id) VALUES (?, ?, 1, ?, ?)');
  const parentId = add.run('vidya', 'aaaa0001', '500', null).lastInsertRowid;
  const subId = add.run('Stellaris', 'aaaa0002', '501', parentId).lastInsertRowid;

  const ts = (i) => new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString();
  const msgs = (prefix, n, base) => Array.from({ length: n }, (_, i) => ({ discordId: `${base}${i}`, author: 'someone', content: `${prefix} ${i}`, timestamp: ts(i) }));
  const data = { channels: [
    { discordId: '500', name: 'vidya', kind: 'text', messages: msgs('channel', 3, 9100) },
    { discordId: '501', name: 'Stellaris', kind: 'thread', parentId: '500', messages: msgs('stellaris', 4, 9200) },
    { discordId: '502', name: 'Balls Gate', kind: 'thread', parentId: '500', messages: msgs('balls', 2, 9300) },
  ] };
  const importId = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(os.tmpdir(), `haven-import-${importId}.json`), JSON.stringify(data));

  const started = await call('POST /api/import/discord/execute', {
    headers: { authorization: 'Bearer admin' },
    body: { importId, selectedChannels: data.channels.map(c => ({ discordId: c.discordId, originalName: c.name, name: c.name })) },
  });
  assert.equal(started.status, 202);
  let done;
  for (let i = 0; i < 500 && !done; i++) {
    const r = await call('GET /api/import/discord/execute/:jobId', { headers: { authorization: 'Bearer admin' }, params: { jobId: started.body.jobId } });
    if (r.body.state === 'done') done = r; else await sleep(5);
  }
  assert.ok(done, 'the import finished');
  assert.equal(done.body.success, true);
  assert.equal(done.body.channelsCreated, 0, 'no channel is made for a linked thread');
  assert.equal(done.body.threadsImported, 1, 'only the unlinked thread becomes a Haven thread');

  const inSub = db.prepare('SELECT content, thread_id FROM messages WHERE channel_id = ? ORDER BY id').all(subId);
  assert.deepEqual(inSub.map(m => m.content), ['stellaris 0', 'stellaris 1', 'stellaris 2', 'stellaris 3']);
  assert.ok(inSub.every(m => m.thread_id === null), 'they are plain messages in the sub-channel');

  const root = db.prepare("SELECT id FROM messages WHERE channel_id = ? AND discord_message_id = '502'").get(parentId);
  assert.ok(root, 'the other thread hangs from a line in the parent channel');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').get(root.id).n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND content LIKE 'stellaris%'").get(parentId).n, 0,
    'nothing from the linked thread lands in the parent');
});
