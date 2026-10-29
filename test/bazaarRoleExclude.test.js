/**
 * Bizarre Bazaar fork: hiding a channel from roles (src/bazaarRoleExclude.js).
 * Anyone holding a hidden role, server-wide or in that channel, loses the
 * channel from their list and cannot read or post in it, even when they hold
 * its required roles. The admin always sees it.
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

const PORT = 3652;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-bazaarexclude-${Date.now()}`);

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

const call = (sock, event, data) => new Promise((res) => sock.emit(event, data, res));

// The next channel list that does (or does not) show this channel.
const listShowing = (sock, code, shown) => next(sock, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.code === code) === shown);

async function currentList(sock) {
  const p = next(sock, 'channels-list', (chs) => Array.isArray(chs));
  sock.emit('get-channels');
  return p;
}

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
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (err) { console.warn('[bazaarRoleExclude test] could not remove the scratch data dir:', err.message); }
});

test('hiding a channel from roles', async (t) => {
  const admin = await register('admin');
  const bob = await register('bob');
  const carol = await register('carol');
  assert.ok(admin.token && bob.token && carol.token, 'accounts registered');
  const A = await connect(admin.token);
  const B = await connect(bob.token);
  const C = await connect(carol.token);

  let list = next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'plaza'));
  A.emit('create-channel', { name: 'plaza' });
  const plaza = (await list).find((c) => c.name === 'plaza');
  const code = plaza.code;
  for (const s of [B, C]) s.emit('join-channel', { code });
  await wait(300);
  assert.ok((await currentList(B)).some((c) => c.code === code), 'bob is in the channel');

  const anti = await call(A, 'create-role', { name: 'Anti-Slog', level: 5 });
  assert.ok(anti && anti.success, `role created: ${JSON.stringify(anti)}`);
  assert.ok(!(await call(A, 'assign-role', { userId: bob.user.id, roleId: anti.roleId })).error, 'bob holds the role');
  await wait(200);

  await t.test('off by default: holding the role changes nothing', async () => {
    assert.ok((await currentList(B)).some((c) => c.code === code));
  });

  await t.test('only the admin sets it', async () => {
    const r = await call(B, 'bazaar-set-channel-role-exclude', { code, roles: [anti.roleId] });
    assert.ok(r && r.error, 'a member is refused');
  });

  await t.test('the channel leaves the list of the role\'s holders and refuses them', async () => {
    const gone = listShowing(B, code, false);
    const r = await call(A, 'bazaar-set-channel-role-exclude', { code, roles: [anti.roleId, 999999] });
    assert.deepStrictEqual(r && r.roles, [anti.roleId], 'unknown roles are dropped');
    assert.ok(await gone, 'bob\'s sidebar loses it straight away');

    const refused = next(B, 'error-msg');
    B.emit('get-messages', { code });
    assert.ok(await refused, 'bob cannot read it');
    B.emit('send-message', { code, content: 'from bob' });
    await wait(300);
    const hist = next(A, 'message-history', (d) => d && d.channelCode === code);
    A.emit('get-messages', { code });
    assert.ok(!(await hist).messages.some((m) => m.content === 'from bob'), 'nor post in it');
  });

  await t.test('everyone else, and the admin, still see it; only the admin sees the setting', async () => {
    const carolList = await currentList(C);
    const forCarol = carolList.find((c) => c.code === code);
    assert.ok(forCarol, 'carol still sees it');
    assert.strictEqual(forCarol.bazaar_role_exclude, undefined, 'members are not told which roles are hidden');
    const forAdmin = (await currentList(A)).find((c) => c.code === code);
    assert.ok(forAdmin, 'the admin still sees it');
    assert.deepStrictEqual(JSON.parse(forAdmin.bazaar_role_exclude), [anti.roleId]);
  });

  await t.test('the role given only in this channel hides it too', async () => {
    const gone = listShowing(C, code, false);
    const r = await call(A, 'assign-role', { userId: carol.user.id, roleId: anti.roleId, channelId: plaza.id });
    assert.ok(r && !r.error, `channel role given: ${JSON.stringify(r)}`);
    assert.ok(await gone, 'carol loses it');
    await call(A, 'revoke-role', { userId: carol.user.id, roleId: anti.roleId, channelId: plaza.id });
  });

  await t.test('hidden wins over required roles', async () => {
    const key = await call(A, 'create-role', { name: 'Key', level: 5 });
    await call(A, 'assign-role', { userId: bob.user.id, roleId: key.roleId });
    const g = await call(A, 'set-channel-role-gate', { code, mode: 'any', roles: [key.roleId] });
    assert.ok(g && g.success, `gate set: ${JSON.stringify(g)}`);
    await wait(300);
    assert.ok(!(await currentList(B)).some((c) => c.code === code), 'bob holds the key and is still hidden from it');
    await call(A, 'set-channel-role-gate', { code, mode: 'any', roles: [] });
  });

  await t.test('switching it off, or deleting the role, shows the channel again', async () => {
    let back = listShowing(B, code, true);
    await call(A, 'bazaar-set-channel-role-exclude', { code, roles: [] });
    assert.ok(await back, 'cleared: bob sees it again');

    await call(A, 'bazaar-set-channel-role-exclude', { code, roles: [anti.roleId] });
    await wait(300);
    assert.ok(!(await currentList(B)).some((c) => c.code === code), 'hidden again');
    const del = await call(A, 'delete-role', { roleId: anti.roleId });
    assert.ok(del && !del.error, `role deleted: ${JSON.stringify(del)}`);
    await wait(300);
    assert.ok((await currentList(B)).some((c) => c.code === code), 'a deleted role hides nothing');
    const forAdmin = (await currentList(A)).find((c) => c.code === code);
    assert.ok(!forAdmin.bazaar_role_exclude, 'and is cleared from the setting');
  });

  A.close();
  B.close();
  C.close();
});
