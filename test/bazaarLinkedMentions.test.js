'use strict';

// Bizarre Bazaar fork: Discord @mentions of linked people become Haven
// @mentions (src/bazaarLinkedMentions.js).
//
//   node --test test/bazaarLinkedMentions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness } = require('./socketServerHarness');
const linked = require('../src/bazaarLinkedMentions');
const pings = require('../src/bazaarFerryPings');

const PORT = 3633;
const h = createHarness(PORT, 'bazaar-linked-mentions');
const D1 = '111111111111111111';
const D2 = '222222222222222222';
const D3 = '333333333333333333';

let db;
let admin;
let kar;
const ids = {};

test.before(async () => {
  await h.start();
  admin = await h.register('admin');
  kar = await h.register('kardrin');
  db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  const ch = db.prepare("INSERT INTO channels (name, code, created_by, discord_channel_id) VALUES ('quotes', 'bzlm0001', ?, '900000000000000001')").run(admin.id).lastInsertRowid;
  for (const u of [admin.id, kar.id]) db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(ch, u);
  db.prepare("INSERT INTO bazaar_discord_links (user_id, discord_id, discord_username, source) VALUES (?, ?, 'kar', 'discord')").run(kar.id, D1);
  db.prepare("INSERT INTO bazaar_discord_links (user_id, discord_id, discord_username, source) VALUES (?, ?, 'adm', 'none')").run(admin.id, D3);
  const add = (content, userId = null, n = 0) => db.prepare(
    "INSERT INTO messages (channel_id, user_id, content, imported_from, discord_message_id, created_at) VALUES (?, ?, ?, 'discord', ?, '2024-01-01 00:00:00')"
  ).run(ch, userId, content, userId ? null : String(800000000000000000n + BigInt(n))).lastInsertRowid;
  ids.plain = add(`hi <@${D1}> look`, null, 1);
  ids.tight = add(`<@!${D1}>s and x<@${D1}>`, null, 2);
  ids.other = add(`<@${D2}> is not linked`, null, 3);
  ids.none = add(`<@${D3}> linked without a result`, null, 4);
  ids.haven = add(`typed in Haven: <@${D1}>`, admin.id);
  // A Discord message Ferry carried, with a pair: still nothing goes back.
  db.prepare("INSERT INTO ferry_message_map (haven_message_id, discord_message_id, discord_channel_id) VALUES (?, '800000000000000001', '900000000000000001')").run(ids.plain);
});

test.after(async () => {
  try { db.close(); } catch { /* closed */ }
  await h.stop();
});

const content = (id) => db.prepare('SELECT content FROM messages WHERE id = ?').get(id).content;
const outbox = () => db.prepare('SELECT COUNT(*) AS n FROM bazaar_ferry_outbox').get().n;

async function search(token, query) {
  const s = await h.connect(token);
  const got = h.next(s, 'search-results', (d) => d && d.token === 'q');
  s.emit('search-messages', { query, token: 'q' });
  const res = await got;
  s.close();
  return (res && res.results ? res.results : []).map(r => r.id);
}

test('a link turns old codes into @mentions, and only for that person', async () => {
  const before = outbox();
  const r = await linked.reconcile(db);
  assert.equal(r.written, 2);
  assert.equal(content(ids.plain), 'hi @kardrin look');
  assert.equal(content(ids.tight), '@kardrin s and x @kardrin', 'a word next to the code keeps the mention apart');
  assert.equal(content(ids.other), `<@${D2}> is not linked`);
  assert.equal(content(ids.none), `<@${D3}> linked without a result`);
  assert.equal(content(ids.haven), `typed in Haven: <@${D1}>`, 'Haven messages are never touched');
  assert.equal(outbox(), before, 'nothing is queued for Discord');
  assert.equal(db.prepare('SELECT edited_at FROM messages WHERE id = ?').get(ids.plain).edited_at, null, 'no edited mark');
  assert.equal((await linked.reconcile(db)).written, 0, 'a second run finds nothing');
});

test('they are searchable and on the @ list', async () => {
  const mine = await search(kar.token, 'mentions:me');
  assert.ok(mine.includes(ids.plain) && mine.includes(ids.tight), JSON.stringify(mine));
  const byName = await search(admin.token, 'kardrin');
  assert.ok(byName.includes(ids.plain), JSON.stringify(byName));
});

test('old mentions do not light up the channel list, new ones do', async () => {
  const quotes = async () => {
    const s = await h.connect(kar.token);
    const list = await h.channels(s);
    s.close();
    return list.find(c => c.code === 'bzlm0001');
  };
  const before = await quotes();
  assert.ok(before && before.unreadCount > 0, 'never opened, so unread');
  assert.equal(before.unreadMentionIds, undefined, JSON.stringify(before.unreadMentionIds));
  const fresh = db.prepare("INSERT INTO messages (channel_id, user_id, content, is_webhook, webhook_username) VALUES ((SELECT id FROM channels WHERE code = 'bzlm0001'), NULL, 'new from Discord @kardrin', 1, 'someone')").run().lastInsertRowid;
  const after = await quotes();
  assert.deepEqual(after.unreadMentionIds, [Number(fresh)]);
  db.prepare('DELETE FROM messages WHERE id = ?').run(fresh);
});

test('Ferry writes a linked person as @login from the start', () => {
  const msg = { mentions: [{ id: D1, username: 'kar' }, { id: D2, username: 'other' }] };
  assert.equal(pings.keepPersonCodes(db, `yo <@!${D1}> and <@${D2}>`, msg), `yo @kardrin and <@${D2}>`);
  assert.equal(linked.forText(db, 'no codes here'), 'no codes here');
});

test('a new login is followed, and an unlink puts the codes back', async () => {
  db.prepare("UPDATE users SET username = 'kard2' WHERE id = ?").run(kar.id);
  await linked.reconcile(db);
  assert.equal(content(ids.plain), 'hi @kard2 look');
  db.prepare('DELETE FROM bazaar_discord_links WHERE user_id = ?').run(kar.id);
  await linked.reconcile(db);
  assert.equal(content(ids.plain), `hi <@${D1}> look`);
  assert.equal(content(ids.tight), `<@${D1}> s and x <@${D1}>`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bazaar_linked_mentions').get().n, 0);
});

test('calls while it runs are not lost', async () => {
  db.prepare("INSERT INTO bazaar_discord_links (user_id, discord_id, discord_username, source) VALUES (?, ?, 'kar', 'discord')").run(kar.id, D1);
  const a = linked.reconcile(db);
  const b = linked.reconcile(db);
  await Promise.all([a, b]);
  await new Promise(r => setTimeout(r, 50));
  while (await linked.reconcile(db).then(x => x.written)) { /* settle */ }
  assert.equal(content(ids.plain), 'hi @kard2 look');
});
