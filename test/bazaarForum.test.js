/**
 * Bizarre Bazaar fork: staff-only new posts in a forum (src/bazaarForum.js),
 * and role names up to 100 characters. With the switch on, a member can
 * still reply inside a post but cannot start one; the admin and holders of
 * read_only_override can.
 *
 * Boots its own Haven server on a scratch port and data dir.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');

const PORT = 3651;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-bazaarforum-${Date.now()}`);
const REFUSAL = 'Only staff can start new posts in this forum. Reply inside an existing post instead.';

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const register = (username) => post('/api/auth/register', { username, password: 'bazaartest123', eulaVersion: '2.0', ageVerified: true });
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

function history(sock, code) {
  const p = next(sock, 'message-history', (d) => d && d.channelCode === code);
  sock.emit('get-messages', { code });
  return p;
}

function thread(sock, parentId) {
  const p = next(sock, 'thread-messages', (d) => d && d.parentId === parentId);
  sock.emit('get-thread-messages', { parentId });
  return p;
}

const reply = (sock, parentId, content) => new Promise((res) => sock.emit('send-thread-message', { parentId, content }, res));
const call = (sock, event, data) => new Promise((res) => sock.emit(event, data, res));

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
});

test.after(async () => {
  if (server && server.exitCode === null) { const gone = new Promise((r) => server.once('exit', r)); server.kill(); await gone; }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (err) { console.warn('[bazaarForum test] could not remove the scratch data dir:', err.message); }
});

test('staff-only new posts in a forum', async (t) => {
  const admin = await register('admin');
  const bob = await register('bob');
  assert.ok(admin.token && bob.token, 'accounts registered');
  const A = await connect(admin.token);
  const B = await connect(bob.token);

  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'notices'));
  A.emit('create-channel', { name: 'notices' });
  const code = (await list).find((c) => c.name === 'notices').code;
  list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.is_forum === 1));
  A.emit('toggle-channel-permission', { code, permission: 'forum' });
  assert.ok(await list, 'forum mode on');
  A.emit('enter-channel', { code });
  B.emit('join-channel', { code });
  await wait(200);
  B.emit('enter-channel', { code });
  await wait(200);

  await t.test('off by default: a member starts a post', async () => {
    B.emit('send-message', { code, content: 'hello all', title: 'Hi' });
    await wait(200);
    assert.ok((await history(B, code)).messages.some((m) => m.content === 'hello all'));
  });

  await t.test('only someone who can change the channel settings turns it on', async () => {
    const refused = next(B, 'error-msg');
    B.emit('toggle-channel-permission', { code, permission: 'bazaar_staff_topics' });
    assert.ok(await refused, 'a member is refused');
    list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code && c.bazaar_staff_topics === 1));
    A.emit('toggle-channel-permission', { code, permission: 'bazaar_staff_topics' });
    assert.ok(await list, 'the channel list carries the setting');
  });

  let topic;
  await t.test('the admin starts posts, a member is refused', async () => {
    A.emit('send-message', { code, content: 'server rules', title: 'Rules' });
    await wait(200);
    topic = (await history(A, code)).messages.find((m) => m.content === 'server rules');
    assert.ok(topic, 'the admin\'s post went up');

    const refused = next(B, 'error-msg', (m) => m === REFUSAL);
    B.emit('send-message', { code, content: 'my own post', title: 'Mine' });
    assert.strictEqual(await refused, REFUSAL);
    const pollRefused = next(B, 'error-msg', (m) => m === REFUSAL);
    B.emit('create-poll', { code, question: 'Pizza?', options: ['yes', 'no'] });
    assert.strictEqual(await pollRefused, REFUSAL, 'a poll would be a new post too');
    const scheduled = await call(B, 'schedule-message', { code, content: 'later post', sendAt: new Date(Date.now() + 3600000).toISOString() });
    assert.strictEqual(scheduled && scheduled.error, REFUSAL, 'so would a scheduled message');
    await wait(200);
    const msgs = (await history(A, code)).messages.map((m) => m.content);
    assert.ok(!msgs.includes('my own post') && !msgs.some((c) => /Pizza/.test(c)), 'nothing new from the member');
  });

  await t.test('a member still replies inside an existing post', async () => {
    await reply(B, topic.id, 'read them, thanks');
    const th = await thread(A, topic.id);
    assert.ok(th.messages.some((m) => m.content === 'read them, thanks'));
  });

  await t.test('a role with read_only_override starts posts, and its name can be 100 characters', async () => {
    const name = 'Staff '.padEnd(100, 'x');
    const made = await call(A, 'create-role', { name, level: 10, permissions: ['read_only_override'] });
    assert.ok(made && made.success, `role created: ${JSON.stringify(made)}`);
    const tooLong = await call(A, 'create-role', { name: 'y'.repeat(101), level: 10 });
    assert.ok(tooLong && tooLong.error, '101 characters is refused');
    const given = await call(A, 'assign-role', { userId: bob.user.id, roleId: made.roleId });
    assert.ok(given && !given.error, `role assigned: ${JSON.stringify(given)}`);
    await wait(300);
    B.emit('send-message', { code, content: 'staff post', title: 'Staff' });
    await wait(300);
    assert.ok((await history(A, code)).messages.some((m) => m.content === 'staff post'));
  });

  A.close();
  B.close();
});
