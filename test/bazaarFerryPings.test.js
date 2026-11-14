'use strict';

// Bizarre Bazaar fork: Discord @mentions that reach the Haven people they name
// (src/bazaarFerryPings.js, app-bazaar-discord-refs.js). Every Discord id
// here is made up.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-ferrypings-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const { initDatabase } = require('../src/database');
const pings = require('../src/bazaarFerryPings');
const db = initDatabase();

const D = { ted: '410000000000000001', ann: '410000000000000002', stranger: '410000000000000003', unlinked: '410000000000000004' };

// Ted and Ann linked Discord; Una's link was undone (source 'none').
db.prepare("INSERT INTO users (id, username, password_hash, display_name) VALUES (7, 'ted', 'x', 'Ted Shown'), (8, 'ann', 'x', NULL), (9, 'una', 'x', NULL)").run();
db.prepare("INSERT INTO bazaar_discord_links (user_id, discord_id, discord_username, source) VALUES (7, ?, 'teddisc', 'oauth'), (8, ?, 'anndisc', 'oauth'), (9, ?, 'unadisc', 'none')")
  .run(D.ted, D.ann, D.unlinked);
const chId = db.prepare("INSERT INTO channels (name, code) VALUES ('general', 'gen12345')").run().lastInsertRowid;
const msgRow = (content, replyTo = null) => db.prepare('INSERT INTO messages (channel_id, user_id, content, reply_to) VALUES (?, NULL, ?, ?)').run(chId, content, replyTo).lastInsertRowid;

const person = (id, username, extra = {}) => ({ id, username, global_name: null, ...extra });
const discordMsg = (content, mentions, extra = {}) => ({ id: '420000000000000001', content, mentions, author: person('430000000000000001', 'sam', { global_name: 'Sam' }), ...extra });

test('person codes are kept and their Discord names saved', () => {
  const msg = discordMsg(`hi <@!${D.stranger}> and <@${D.ted}>`, [
    person(D.stranger, 'strangerdisc', { global_name: 'Stranger', member: { nick: 'Stranger Nick' } }),
    person(D.ted, 'teddisc'),
  ]);
  assert.equal(pings.keepPersonCodes(db, msg.content, msg), `hi <@${D.stranger}> and <@${D.ted}>`);
  const name = (id) => db.prepare("SELECT name FROM bazaar_discord_names WHERE kind = 'user' AND discord_id = ?").get(id)?.name;
  assert.equal(name(D.stranger), 'Stranger Nick', 'the server nickname is the name Discord shows there');
  assert.equal(name(D.ted), 'teddisc');
  // Nothing to save, or no database: the codes are still kept.
  assert.equal(pings.keepPersonCodes(null, `<@!${D.ann}>`, {}), `<@${D.ann}>`);
});

test('only accounts still linked count', () => {
  const ids = pings.linkedUsers(db, [D.ted, D.unlinked, D.stranger]).map(u => u.id).sort();
  assert.deepEqual(ids, [7]);
  assert.deepEqual(pings.linkedUsers(db, []), []);
});

test('notification text reads codes as names', () => {
  assert.equal(pings.readableText(db, `<@${D.ted}> <@${D.stranger}> <@${D.unlinked}> <@499999999999999999>`),
    '@Ted Shown @Stranger Nick <@410000000000000004> <@499999999999999999>');
});

test('linked people mentioned are pushed, once per Haven copy', () => {
  const calls = [];
  const push = (...args) => calls.push(args);
  const id = msgRow(`hey <@${D.ted}> <@${D.ann}> <@${D.stranger}>`);
  const msg = discordMsg(`hey <@${D.ted}> <@${D.ann}> <@${D.stranger}>`, [person(D.ted, 'teddisc'), person(D.ann, 'anndisc'), person(D.stranger, 'x')]);
  pings.notify(db, push, msg, `hey <@${D.ted}> <@${D.ann}> <@${D.stranger}>`, [{ havenMessageId: id, channelCode: 'gen12345' }]);
  assert.equal(calls.length, 1);
  const [channelId, code, channelName, senderId, sender, text, opts] = calls[0];
  assert.equal(channelId, chId);
  assert.equal(code, 'gen12345');
  assert.equal(channelName, 'general');
  assert.equal(senderId, 0);
  assert.equal(sender, 'Sam');
  assert.equal(text, 'hey @Ted Shown @ann @Stranger Nick');
  assert.deepEqual(opts.onlyUserIds.sort(), [7, 8]);
  // Matched by a device set to pings only (src/pushMutes.js pingsName).
  assert.match(opts.pingText, /@ted/);
  assert.match(opts.pingText, /@ann/);
});

test('nobody is pushed for @silent, unlinked people, or the author already told of a reply', () => {
  const calls = [];
  const push = (...args) => calls.push(args);
  const target = (hid) => [{ havenMessageId: hid, channelCode: 'gen12345' }];

  const silent = discordMsg(`<@${D.ted}>`, [person(D.ted, 'teddisc')], { flags: 1 << 12 });
  pings.notify(db, push, silent, silent.content, target(msgRow(silent.content)));

  const strangers = discordMsg(`<@${D.stranger}> <@${D.unlinked}>`, [person(D.stranger, 'x'), person(D.unlinked, 'y')]);
  pings.notify(db, push, strangers, strangers.content, target(msgRow(strangers.content)));

  // Ann replied to Ted's Haven message from Discord, which also mentions him:
  // the reply already pushed him.
  const teds = db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, 7, 'my post')").run(chId).lastInsertRowid;
  const reply = discordMsg(`<@${D.ted}>`, [person(D.ted, 'teddisc')], { type: 19 });
  pings.notify(db, push, reply, reply.content, target(msgRow(reply.content, teds)));
  assert.equal(calls.length, 0);

  // No push function (no socket runtime yet), or no copies: nothing breaks.
  assert.deepEqual(pings.notify(db, undefined, reply, reply.content, target(1)), []);
  assert.deepEqual(pings.notify(db, push, reply, reply.content, []), []);
});

// ── The client side, run the way test/bazaarDiscordRefs.test.js runs it ──
const ROOT = path.join(__dirname, '..');
const timers = [];
function loadApp() {
  const sandbox = {
    setTimeout: (fn) => timers.push(fn), clearTimeout: () => {},
    document: { documentElement: { lang: 'en-US' }, querySelectorAll: () => [], createElement: () => ({}) },
    navigator: { languages: ['en-US'] },
    setInterval: () => 0, clearInterval: () => {},
    Intl, Date, Number, Math, JSON, String, Array, Object, RegExp, Error,
    t: (key) => key.split('.').pop(),
    console,
  };
  const methods = {};
  for (const name of ['app-utilities.js', 'app-bazaar-discord-refs.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8');
    const context = vm.createContext({ module: { exports: {} }, exports: {}, ...sandbox });
    vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context, { filename: name });
    Object.assign(methods, context.module.exports);
  }
  const app = Object.create(methods);
  app.user = { id: 7, username: 'ted', roles: [] };
  app.channels = [{ id: 3, name: 'quotes', code: 'abcd1234', is_dm: 0 }];
  app._nicknames = {};
  app.notifications = { roleMentionsEnabled: true };
  app._bazaarDiscordRefs = {
    users: { [D.ted]: { name: 'Ted Shown', userId: 7 }, [D.ann]: { name: 'ann', userId: 8 }, [D.stranger]: { name: 'Stranger' } },
    roles: {}, channels: { '440000000000000001': { channelId: 3 } },
  };
  return app;
}

test('a code naming the viewer\'s linked account is a mention of them', () => {
  const app = loadApp();
  assert.equal(app._bazaarMentionsMe(`hey <@${D.ted}>`), true);
  assert.equal(app._bazaarMentionsMe(`hey <@!${D.ted}>`), true);
  assert.equal(app._bazaarMentionsMe(`hey <@${D.ann}> <@${D.stranger}>`), false);
  assert.equal(app._bazaarMentionsMe('hey ted'), false);
  // Every mention check the client makes goes through _mentionsMyRole, and
  // the Discord one holds even with role pings switched off.
  app.notifications.roleMentionsEnabled = false;
  assert.equal(app._mentionsMyRole(`<@${D.ted}>`), true);
  // Before the names load nobody is matched.
  app._bazaarDiscordRefs = null;
  assert.equal(app._bazaarMentionsMe(`hey <@${D.ted}>`), false);
});

test('a notification reads codes as names', () => {
  const app = loadApp();
  app._nicknames = { 8: 'Annie' };
  assert.equal(app._bazaarDiscordRefsText(`<@${D.ted}> <@${D.ann}> <@${D.stranger}> <@499999999999999999> in <#440000000000000001>`),
    '@Ted Shown @Annie @Stranger <@499999999999999999> in #quotes');
});

test('an unknown person asks for the names again, once', () => {
  const app = loadApp();
  let asked = 0;
  app.socket = { emit: (ev) => { if (ev === 'bazaar-discord-refs') asked++; } };
  timers.length = 0;
  // Several new names arriving together are asked for once, a moment later.
  app._bazaarRefreshDiscordRefs('499999999999999998');
  app._bazaarRefreshDiscordRefs('499999999999999999');
  app._bazaarRefreshDiscordRefs('499999999999999999');
  assert.equal(app._bazaarRefsAsked.size, 2);
  timers[timers.length - 1]();
  assert.equal(asked, 1);
  // The same person again is not asked for again.
  app._bazaarRefreshDiscordRefs('499999999999999999');
  assert.equal(timers.length, 2);
});
