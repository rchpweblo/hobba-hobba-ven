'use strict';

// Bizarre Bazaar fork: the Role Bot (src/bazaarRoleBot.js) and its Discord
// link (src/bazaarDiscordLinkRoutes.js). Every Discord id here is made up.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-rolebot-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
process.env.BAZAAR_DISCORD_CLIENT_ID = '900000000000000001';
process.env.BAZAAR_DISCORD_CLIENT_SECRET = 'test-secret';
const express = require('express');
const auth = require('../src/auth');
const { initDatabase } = require('../src/database');
const bot = require('../src/bazaarRoleBot');
const { createDiscordLinkRoutes } = require('../src/bazaarDiscordLinkRoutes');
const db = initDatabase();

const GUILD = '100000000000000001';
const D = { pres: '200000000000000001', dm: '200000000000000002', cult: '200000000000000003', other: '200000000000000099' };
const P = { boss: '300000000000000001', gm: '300000000000000002', none: '300000000000000003', left: '300000000000000004', janitor: '300000000000000005', web: '300000000000000006', thief: '300000000000000007' };

const role = (name, opts = {}) => db.prepare('INSERT INTO roles (name, level, scope, auto_assign, link_channel_access) VALUES (?, ?, ?, ?, ?)')
  .run(name, opts.level || 10, opts.scope || 'server', opts.auto ? 1 : 0, opts.link ? 1 : 0).lastInsertRowid;
const channel = (name, parent = null) => db.prepare('INSERT INTO channels (name, code, parent_channel_id) VALUES (?, ?, ?)')
  .run(name, Math.random().toString(36).slice(2, 10), parent).lastInsertRowid;
let nextUser = 1;
const user = (name, { guest = false } = {}) => {
  const id = nextUser++;
  db.prepare('INSERT INTO users (id, username, password_hash, is_guest) VALUES (?, ?, ?, ?)').run(id, name, 'x', guest ? 1 : 0);
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(id, R.ted); // auto-assigned at sign-up
  return id;
};
const rolesOf = (userId) => db.prepare('SELECT r.name, ur.channel_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.name, ur.channel_id').all(userId);

const R = {
  ted: role('Translucent Ted', { level: 1, auto: true, link: true }),
  pres: role('El Presidente', { level: 90 }),
  gm: role('Game Master', { scope: 'channel' }),
  cult: role('Truth Cult', { scope: 'channel' }),
  janitor: role('Janitor', { scope: 'channel' }),
};
const C = { general: channel('general'), tabletops: channel('tabletops'), cult: channel("noah's-cult"), closet: channel("Janitor's Closet") };
C.cultSub = channel('Stellaris', C.cult);
db.prepare('INSERT INTO role_channel_access (role_id, channel_id, grant_on_promote, revoke_on_demote) VALUES (?, ?, 1, 1)').run(R.ted, C.general);
db.prepare("INSERT OR REPLACE INTO server_settings (key, value) VALUES ('ferry_bot_token', 'bot-token')").run();

const refreshed = [];
bot.attach({
  io: { sockets: { sockets: new Map() } }, db,
  roleRefresh: { pushUserRoleState: (id) => refreshed.push(['roles', id]), pushChannelList: (id) => refreshed.push(['channels', id]) },
  syncRoleGateMemberships: ({ userId }) => refreshed.push(['gates', userId]),
});

test('install refuses names it cannot find, and stores nothing', () => {
  assert.throws(() => bot.installRules(db, { guildId: GUILD, roleMap: { [D.pres]: 'Nobody' }, channelOnly: { 'Game Master': ['nowhere'] } }),
    /role "Nobody": not found[\s\S]*channel "nowhere": not found/);
  assert.equal(bot.readRules(db), null);
  assert.equal(bot.isConfigured(db), false);
});

test('install stores names as ids, case-insensitively', () => {
  const counts = bot.installRules(db, {
    guildId: GUILD,
    roleMap: { [D.pres]: 'el presidente', [D.dm]: 'Game Master', [D.cult]: 'Truth Cult' },
    channelOnly: { 'Game Master': ['tabletops'], 'Truth Cult': ["noah's-cult"], Janitor: ["janitor's closet"] },
    extra: { [P.gm]: ['Game Master'], [P.janitor]: ['Janitor'] },
    snapshot: { [P.left]: [D.pres], [P.none]: [] },
  });
  assert.deepEqual(counts, { roles: 3, channelOnly: 3, extra: 2, snapshot: 2 });
  const rules = bot.readRules(db);
  assert.equal(rules.roleMap[D.pres], R.pres);
  assert.deepEqual(rules.channelOnly[R.gm], [C.tabletops]);
  assert.equal(bot.isConfigured(db), true);
});

test('someone with no Discord roles keeps Translucent Ted and loses nothing', () => {
  const id = user('roleless');
  const r = bot.linkAndGrant(db, id, { discordId: P.none, discordUsername: 'roleless', memberRoles: [GUILD] });
  assert.equal(r.source, 'discord');
  assert.deepEqual(r.given, []);
  assert.deepEqual(rolesOf(id), [{ name: 'Translucent Ted', channel_id: null }]);
});

test('El Presidente is given server-wide, and unknown Discord roles are counted, not given', () => {
  const id = user('boss');
  const r = bot.linkAndGrant(db, id, { discordId: P.boss, discordUsername: 'boss', memberRoles: [D.pres, D.other] });
  assert.deepEqual(r.given, [{ name: 'El Presidente' }]);
  assert.equal(r.unmapped, 1);
  assert.deepEqual(rolesOf(id), [{ name: 'El Presidente', channel_id: null }, { name: 'Translucent Ted', channel_id: null }]);
});

test('channel-only roles go in their channels only, never server-wide or in sub-channels', () => {
  const id = user('gm');
  const r = bot.linkAndGrant(db, id, { discordId: P.gm, discordUsername: 'gm', memberRoles: [D.dm, D.cult] });
  assert.deepEqual(r.given.map(g => g.name).sort(), ['Game Master', 'Truth Cult']);
  assert.deepEqual(r.given.find(g => g.name === 'Game Master').channels, ['tabletops']);
  assert.deepEqual(rolesOf(id), [
    { name: 'Game Master', channel_id: C.tabletops },
    { name: 'Translucent Ted', channel_id: null },
    { name: 'Truth Cult', channel_id: C.cult },
  ]);
});

test('extra grants by Discord id: Janitor for someone with no Discord roles', () => {
  const id = user('janitor');
  const r = bot.linkAndGrant(db, id, { discordId: P.janitor, discordUsername: 'janitor', memberRoles: [] });
  assert.deepEqual(r.given, [{ name: 'Janitor', channels: ["Janitor's Closet"] }]);
  assert.ok(rolesOf(id).some(x => x.name === 'Janitor' && x.channel_id === C.closet));
});

test('someone who left the Discord server gets their roles from the snapshot', () => {
  const id = user('left');
  const r = bot.linkAndGrant(db, id, { discordId: P.left, discordUsername: 'left', memberRoles: null });
  assert.equal(r.source, 'snapshot');
  assert.deepEqual(r.given, [{ name: 'El Presidente' }]);
});

test('a role given by hand already is reported as already held, not doubled', () => {
  const id = user('had-it');
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(id, R.pres);
  const r = bot.linkAndGrant(db, id, { discordId: '300000000000000008', discordUsername: 'had-it', memberRoles: [D.pres] });
  assert.deepEqual(r.given, []);
  assert.deepEqual(r.already, [{ name: 'El Presidente' }]);
  assert.equal(rolesOf(id).filter(x => x.name === 'El Presidente').length, 1);
});

test('linking happens once, and one Discord account links one Haven account', () => {
  const boss = db.prepare("SELECT id FROM users WHERE username = 'boss'").get().id;
  assert.match(bot.linkAndGrant(db, boss, { discordId: P.boss, memberRoles: [D.pres] }).error, /already linked/);
  const other = user('boss-alt');
  assert.match(bot.linkAndGrant(db, other, { discordId: P.boss, memberRoles: [D.pres] }).error, /another Haven account/);
  assert.deepEqual(rolesOf(other), [{ name: 'Translucent Ted', channel_id: null }]);
});

test('a reset lets someone link again, and keeps the roles they were given', () => {
  const boss = db.prepare("SELECT id FROM users WHERE username = 'boss'").get().id;
  assert.equal(bot.resetLink(db, boss), true);
  assert.ok(rolesOf(boss).some(x => x.name === 'El Presidente'));
  assert.equal(bot.linkState(db, boss).linked, false);
});

test('guest accounts cannot link', () => {
  const id = user('guest', { guest: true });
  assert.match(bot.linkAndGrant(db, id, { discordId: '300000000000000009', memberRoles: [D.pres] }).error, /Guest/);
});

// ── The link itself, through the routes ─────────────────────────────────
const discordUsers = { 'code-web': { id: P.web, username: 'webby' }, 'code-boss': { id: P.boss, username: 'boss' } };
const fakeFetch = async (url, opts = {}) => {
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  if (url === 'https://discord.com/api/oauth2/token') {
    const form = new URLSearchParams(String(opts.body));
    assert.equal(form.get('client_secret'), 'test-secret');
    return discordUsers[form.get('code')] ? reply(200, { access_token: 'at:' + form.get('code') }) : reply(400, {});
  }
  if (url === 'https://discord.com/api/v10/users/@me') return reply(200, discordUsers[opts.headers.Authorization.slice('Bearer at:'.length)]);
  const m = url.match(/\/guilds\/(\d+)\/members\/(\d+)$/);
  if (m) {
    assert.equal(m[1], GUILD);
    assert.equal(opts.headers.Authorization, 'Bot bot-token');
    return m[2] === P.web ? reply(200, { roles: [D.dm] }) : reply(404, {});
  }
  throw new Error('unexpected fetch ' + url);
};

let server, base;
test.before(async () => {
  const app = express();
  app.use('/connect/discord', createDiscordLinkRoutes({ getDb: () => db, fetchImpl: fakeFetch }));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_URL = base;
});
test.after(() => {
  server && server.close();
  db.close();
  fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true });
});

const press = (token) => fetch(`${base}/connect/discord/go`, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: base },
  body: new URLSearchParams({ token }),
});

test('the whole link: confirm page, Continue, Discord, roles given and shown', async () => {
  const id = user('web');
  const token = auth.generateConnectToken(id, 'discord');
  const confirm = await fetch(`${base}/connect/discord?token=${encodeURIComponent(token)}`);
  assert.equal(confirm.status, 200);
  assert.match(await confirm.text(), /<b>web<\/b>/);
  assert.match(confirm.headers.get('content-security-policy'), /form-action 'self' https:\/\/discord\.com/);

  const go = await press(token);
  assert.equal(go.status, 303);
  const to = new URL(go.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(to.searchParams.get('scope'), 'identify');
  assert.equal(to.searchParams.get('redirect_uri'), `${base}/connect/discord/callback`);
  const cookie = go.headers.get('set-cookie').split(';')[0];

  refreshed.length = 0;
  const back = await fetch(`${base}/connect/discord/callback?state=${encodeURIComponent(token)}&code=code-web`, { headers: { Cookie: cookie } });
  assert.equal(back.status, 200);
  assert.match(await back.text(), /Game Master <span>in #tabletops<\/span>/);
  assert.ok(rolesOf(id).some(x => x.name === 'Game Master' && x.channel_id === C.tabletops));
  assert.deepEqual(refreshed, [['gates', id], ['roles', id], ['channels', id]]);
  assert.equal(bot.linkState(db, id).discordUsername, 'webby');
});

test("a Discord consent link forwarded to someone else does not hand over their roles", async () => {
  const thief = user('thief');
  const token = auth.generateConnectToken(thief, 'discord');
  assert.equal((await press(token)).status, 303); // the thief presses Continue, keeps the cookie
  // The victim (El Presidente on Discord) approves in their own browser: no cookie.
  const back = await fetch(`${base}/connect/discord/callback?state=${encodeURIComponent(token)}&code=code-boss`);
  assert.equal(back.status, 400);
  assert.match(await back.text(), /same browser/);
  assert.deepEqual(rolesOf(thief), [{ name: 'Translucent Ted', channel_id: null }]);
});

test('Continue only works when pressed on this site, and with a Discord-scoped token', async () => {
  const id = user('other-site');
  const token = auth.generateConnectToken(id, 'discord');
  const cross = await fetch(`${base}/connect/discord/go`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
    body: new URLSearchParams({ token }),
  });
  assert.equal(cross.status, 403);
  assert.equal((await press(auth.generateConnectToken(id, 'spotify'))).status, 401);
});

test('the routes are off until the Role Bot is set up', async () => {
  const saved = process.env.BAZAAR_DISCORD_CLIENT_SECRET;
  delete process.env.BAZAAR_DISCORD_CLIENT_SECRET;
  try {
    assert.equal(bot.isConfigured(db), false);
    assert.equal((await fetch(`${base}/connect/discord?token=x`)).status, 503);
  } finally {
    process.env.BAZAAR_DISCORD_CLIENT_SECRET = saved;
  }
});
