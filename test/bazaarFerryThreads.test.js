/**
 * Bizarre Bazaar fork: Ferry and Discord threads that are Haven sub-channels
 * (src/bazaarFerryThreads.js), and Discord ids kept on relayed thread replies.
 *
 * Boots a Haven server on a scratch port and data dir, pointed at the
 * stand-in Discord in test/fakeDiscord.js, as test/ferryForums.test.js does:
 *   node --test test/bazaarFerryThreads.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const Database = require('better-sqlite3');
const { startFakeDiscord, GUILD_ID, TEXT_ID } = require('./fakeDiscord');

const PORT = 3416;
const DISCORD_PORT = 3417;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-bazaar-ferry-threads-${Date.now()}`);
const FAKE_TOKEN = 'FAKE' + 'x'.repeat(66);

let server;
let discord;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, filter = () => true, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { if (!filter(data)) return; clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  return null;
}

async function bootServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true',
      NODE_ENV: 'test',
      FERRY_TEST_DISCORD_API: `http://127.0.0.1:${DISCORD_PORT}`,
      FERRY_TEST_DISCORD_GATEWAY: `ws://127.0.0.1:${DISCORD_PORT}`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  discord = await startFakeDiscord(DISCORD_PORT);
  await bootServer();
});

test.after(async () => {
  await new Promise((res) => {
    if (!server || server.exitCode !== null) return res();
    server.once('exit', () => res());
    server.kill();
  });
  await discord?.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
});

const ALICE = { id: '1300000000000000100', username: 'alice', global_name: 'Alice', avatar: null, discriminator: '0' };
const discordMessage = (id, channelId, content, extra = {}) =>
  ({ id, channel_id: channelId, guild_id: GUILD_ID, type: 0, content, author: ALICE, attachments: [], embeds: [], mentions: [], ...extra });
const discordThread = (id, name) => ({ id, guild_id: GUILD_ID, parent_id: TEXT_ID, type: 11, name, thread_metadata: { archived: false, locked: false } });

test('a thread that is a sub-channel comes in and goes out there; thread replies keep their Discord id', async (t) => {
  const admin = await post('/api/auth/register', { username: 'admin', password: 'ferrythreads123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(admin.token, 'admin registered');
  const A = await connect(admin.token);

  const tokenOk = next(A, 'ferry:token-ok');
  A.emit('ferry:set-token', { token: FAKE_TOKEN });
  assert.ok(await tokenOk, 'the fake Discord accepted the token');
  A.emit('ferry:set-option', { key: 'ferry_enabled', value: true });
  const connected = await until(async () => {
    const p = next(A, 'ferry:config');
    A.emit('ferry:get-config');
    const c = await p;
    return c && c.state.connected && c.guilds.length ? c : null;
  }, 10000);
  assert.ok(connected, 'Ferry connected to the fake gateway');

  // A chat channel with a sub-channel made from one of its Discord threads.
  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'vidya'));
  A.emit('create-channel', { name: 'vidya' });
  const vidya = (await list).find((c) => c.name === 'vidya');
  list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'stellaris'));
  A.emit('create-sub-channel', { parentCode: vidya.code, name: 'stellaris' });
  const sub = (await list).find((c) => c.name === 'stellaris');
  assert.ok(sub, 'the sub-channel was made');
  const SUB_THREAD = discord.newId();
  const OTHER_THREAD = discord.newId();
  const db = new Database(path.join(DATA, 'haven.db'));
  t.after(() => db.close());
  db.prepare('UPDATE channels SET discord_channel_id = ? WHERE code = ?').run(SUB_THREAD, sub.code);
  const subId = db.prepare('SELECT id FROM channels WHERE code = ?').get(sub.code).id;
  const vidyaId = db.prepare('SELECT id FROM channels WHERE code = ?').get(vidya.code).id;

  const cfg = next(A, 'ferry:config', (c) => c.links.length === 1);
  A.emit('ferry:create-link', { channelCode: vidya.code, guildId: GUILD_ID, discordChannelId: TEXT_ID, direction: 'both', outMode: 'all' });
  assert.ok(await cfg, 'the parent channel is paired');
  discord.dispatch('THREAD_CREATE', discordThread(SUB_THREAD, 'Stellaris'));
  discord.dispatch('THREAD_CREATE', discordThread(OTHER_THREAD, 'Balls Gate'));
  await wait(300);

  await t.test('a message in the thread lands in the sub-channel, once', async () => {
    const MID = discord.newId();
    discord.dispatch('MESSAGE_CREATE', discordMessage(MID, SUB_THREAD, 'new empire just dropped'));
    const row = await until(() => db.prepare('SELECT channel_id, thread_id, discord_message_id FROM messages WHERE content = ?').get('new empire just dropped'));
    assert.ok(row, 'it arrived');
    assert.strictEqual(row.channel_id, subId, 'in the sub-channel');
    assert.strictEqual(row.thread_id, null, 'as a chat line');
    assert.strictEqual(row.discord_message_id, MID);
    discord.dispatch('MESSAGE_CREATE', discordMessage(MID, SUB_THREAD, 'new empire just dropped'));
    await wait(500);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE content = ?').get('new empire just dropped').n, 1, 'a repeat is not stored twice');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND content LIKE '🧵%'").get(vidyaId).n, 0,
      'no thread line in the parent');
  });

  await t.test('a message written in the sub-channel goes into the thread', async () => {
    const before = discord.executions.length;
    A.emit('send-message', { code: sub.code, content: 'from the sub-channel' });
    const sent = await until(() => discord.executions.slice(before).find((e) => e.body && /from the sub-channel/.test(e.body.content)));
    assert.ok(sent, 'it reached Discord');
    assert.strictEqual(sent.threadId, SUB_THREAD, 'into the thread');
    assert.strictEqual(discord.webhooks.get(sent.webhookId).channelId, TEXT_ID, "through the parent channel's webhook");
  });

  await t.test('a reply in an ordinary thread keeps its Discord id and is not stored twice', async () => {
    const RID = discord.newId();
    discord.dispatch('MESSAGE_CREATE', discordMessage(RID, OTHER_THREAD, 'balls gate reply'));
    const row = await until(() => db.prepare('SELECT channel_id, thread_id, discord_message_id FROM messages WHERE content = ?').get('balls gate reply'));
    assert.ok(row, 'it arrived');
    assert.strictEqual(row.channel_id, vidyaId, 'in the parent channel');
    assert.ok(row.thread_id, 'as a thread reply');
    assert.strictEqual(row.discord_message_id, RID);
    discord.dispatch('MESSAGE_CREATE', discordMessage(RID, OTHER_THREAD, 'balls gate reply'));
    await wait(500);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE content = ?').get('balls gate reply').n, 1);
  });

  A.disconnect();
});
