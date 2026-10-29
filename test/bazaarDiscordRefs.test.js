'use strict';

// Bizarre Bazaar fork: Discord's <@id>, <@&id> and <#id> in copied history,
// shown as names (src/bazaarDiscordRefs.js, app-bazaar-discord-refs.js).
// Every Discord id here is made up.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-discordrefs-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const { initDatabase } = require('../src/database');
const refs = require('../src/bazaarDiscordRefs');
const db = initDatabase();

const D = { linked: '400000000000000001', stranger: '400000000000000002', mapped: '500000000000000001', oldRole: '500000000000000002',
  copied: '600000000000000001', hiddenCh: '600000000000000002', gone: '600000000000000003', nobody: '400000000000000009' };

test('ids are found by kind', () => {
  const ids = refs.idsIn(`hi <@${D.linked}> and <@!${D.stranger}>, <@&${D.mapped}> in <#${D.copied}> <@123>`);
  assert.deepEqual([...ids.user].sort(), [D.linked, D.stranger]);
  assert.deepEqual([...ids.role], [D.mapped]);
  assert.deepEqual([...ids.channel], [D.copied]);
});

test('names: Haven links, mapped roles and copied channels win over stored names', () => {
  db.prepare("INSERT INTO users (id, username, password_hash, display_name) VALUES (7, 'ted', 'x', 'Ted Shown')").run();
  db.prepare("INSERT INTO bazaar_discord_links (user_id, discord_id, discord_username, source) VALUES (7, ?, 'teddisc', 'oauth')").run(D.linked);
  const roleId = db.prepare("INSERT INTO roles (name, level, scope, color) VALUES ('Dungeon Master', 5, 'server', '#ff0000')").run().lastInsertRowid;
  db.prepare("INSERT INTO server_settings (key, value) VALUES ('bazaar_role_bot_rules', ?)").run(JSON.stringify({ guildId: '100000000000000001', roleMap: { [D.mapped]: roleId } }));
  const chId = db.prepare("INSERT INTO channels (name, code, discord_channel_id) VALUES ('quotes', 'abcd1234', ?)").run(D.copied).lastInsertRowid;
  refs.saveName(db, 'user', D.linked, 'Old Discord Name');
  refs.saveName(db, 'user', D.stranger, 'Stranger');
  refs.saveName(db, 'role', D.oldRole, 'Retired Role');
  refs.saveName(db, 'channel', D.gone, 'old-channel');
  assert.equal(refs.saveName(db, 'user', '12', 'too short'), false);
  assert.equal(refs.saveName(db, 'emoji', D.stranger, 'x'), false);
  assert.equal(refs.saveName(db, 'user', D.nobody, '  '), false);

  const r = refs.refsFor(db);
  assert.deepEqual(r.users[D.linked], { name: 'Ted Shown', userId: 7 });
  assert.deepEqual(r.users[D.stranger], { name: 'Stranger' });
  assert.equal(r.roles[D.mapped].name, 'Dungeon Master');
  assert.equal(r.roles[D.mapped].roleId, roleId);
  assert.deepEqual(r.roles[D.oldRole], { name: 'Retired Role' });
  // A copied channel goes out by id only, never by name or code.
  assert.deepEqual(r.channels[D.copied], { channelId: chId });
  assert.deepEqual(r.channels[D.gone], { name: 'old-channel' });
});

// ── The client side, run the way test/codeBlocks.test.js runs it ──
const ROOT = path.join(__dirname, '..');
function fakeElement() {
  let text = '';
  return {
    set textContent(v) { text = String(v); },
    get textContent() { return text; },
    get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
}
function loadApp() {
  const sandbox = {
    document: { documentElement: { lang: 'en-US' }, querySelectorAll: () => [], createElement: () => fakeElement() },
    navigator: { languages: ['en-US'] },
    setInterval: () => 0, clearInterval: () => {},
    Intl, Date, Number, Math, JSON, String, Array, Object, RegExp, Error,
    t: (key) => key.split('.').pop(),
    console,
  };
  const methods = {};
  for (const name of ['app-utilities.js', 'app-message-content.js', 'app-context.js', 'app-bazaar-discord-refs.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8');
    const context = vm.createContext({ module: { exports: {} }, exports: {}, ...sandbox });
    vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context, { filename: name });
    Object.assign(methods, context.module.exports);
  }
  const app = Object.create(methods);
  app.user = { id: 7, username: 'ted', roles: [] };
  app.channels = [{ id: 3, name: 'quotes', code: 'abcd1234', is_dm: 0 }];
  app.channelMembers = [];
  app._nicknames = {};
  return app;
}

const REFS = {
  users: { [D.linked]: { name: 'Ted Shown', userId: 7 }, [D.stranger]: { name: 'Stranger' } },
  roles: { [D.mapped]: { name: 'Dungeon Master', roleId: 2, color: '#ff0000' } },
  channels: { [D.copied]: { channelId: 3 }, [D.hiddenCh]: { channelId: 99 }, [D.gone]: { name: 'old-channel' } },
};

test('codes stay as typed until the names have loaded', () => {
  const app = loadApp();
  assert.match(app._formatContent(`hi <@${D.stranger}>`), /&lt;@400000000000000002&gt;/);
});

test('people, roles and channels read as names', () => {
  const app = loadApp();
  app._bazaarDiscordRefs = REFS;
  const html = app._formatContent(`<@${D.stranger}> <@!${D.linked}> <@${D.nobody}> <@&${D.mapped}> <@&${D.oldRole}>`);
  assert.match(html, /<span class="mention"[^>]*>@Stranger<\/span>/);
  assert.match(html, /<span class="mention mention-self"[^>]*>@Ted Shown<\/span>/);
  assert.match(html, /@unknown_user/);
  assert.match(html, /mention-role[^>]*--role-color:#ff0000[^>]*>.*@Dungeon Master/);
  assert.match(html, /@deleted_role/);
  assert.doesNotMatch(html, /&lt;@/);

  const ch = app._formatContent(`see <#${D.copied}>, <#${D.hiddenCh}>, <#${D.gone}> and <#${D.nobody}>`);
  assert.match(ch, /<span class="channel-link" data-channel-code="abcd1234">#quotes<\/span>/);
  assert.match(ch, /#no_access/);
  assert.match(ch, /#old-channel/);
  assert.match(ch, /#unknown_channel/);
});

test('a nickname the viewer gave someone wins, and names are escaped', () => {
  const app = loadApp();
  app._nicknames = { 7: 'Teddy' };
  app._bazaarDiscordRefs = { ...REFS, users: { ...REFS.users, [D.stranger]: { name: '<img src=x onerror=alert(1)>' } } };
  const html = app._formatContent(`<@${D.linked}> <@${D.stranger}>`);
  assert.match(html, /@Teddy/);
  assert.doesNotMatch(html, /<img/);
});

test('codes inside a code block stay as they are', () => {
  const app = loadApp();
  app._bazaarDiscordRefs = REFS;
  assert.doesNotMatch(app._formatContent('```\n<@' + D.stranger + '>\n```'), /@Stranger/);
});
