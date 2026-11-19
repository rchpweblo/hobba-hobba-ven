'use strict';

// Bizarre Bazaar fork: reactions on copied history, sub-channels and threads
// (src/bazaarFerryReactions.js), and putting the reactions already there in
// line with Discord's (src/bazaarReactionSync.js).
//
//   node --test test/bazaarReactionSync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness } = require('./socketServerHarness');
const fr = require('../src/bazaarFerryReactions');
const ferryReactions = require('../src/ferryReactions');
const sync = require('../src/bazaarReactionSync');
const { isUsableEmoji } = require('../src/builtinEmojis');

const PORT = 3634;
const h = createHarness(PORT, 'bazaar-reaction-sync');
const G = '400000000000000001';
const BOT = '500000000000000001';
const C_A = '410000000000000001'; // paired chat channel
const T_S = '410000000000000002'; // thread with a sub-channel of its own
const C_U = '410000000000000003'; // not paired
const C_F = '410000000000000004'; // paired forum
const U1 = '600000000000000001';
const U2 = '600000000000000002';
const U3 = '600000000000000003';
const U9 = '600000000000000009';

let db;
let admin;
let bob;
const m = {};
const ch = {};

test.before(async () => {
  await h.start();
  admin = await h.register('admin');
  bob = await h.register('bob');
  db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  const chan = (name, code, discordId, extra = {}) => db.prepare(
    `INSERT INTO channels (name, code, created_by, discord_channel_id, parent_channel_id, is_forum) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(name, code, admin.id, discordId, extra.parent || null, extra.forum ? 1 : 0).lastInsertRowid;
  ch.a = chan('chat', 'bzrs0001', C_A);
  ch.s = chan('sub', 'bzrs0002', T_S, { parent: ch.a });
  ch.u = chan('loose', 'bzrs0003', C_U);
  ch.f = chan('ideas', 'bzrs0004', C_F, { forum: true });
  const link = db.prepare("INSERT INTO ferry_links (channel_id, guild_id, discord_channel_id, direction, out_mode) VALUES (?, ?, ?, 'both', 'all')");
  link.run(ch.a, G, C_A);
  link.run(ch.f, G, C_F);
  db.prepare("INSERT INTO custom_emojis (name, filename, uploaded_by) VALUES ('pepe', 'pepe.png', ?)").run(admin.id);

  const msg = (channelId, discordId, { thread = null, user = null, imported = true } = {}) => db.prepare(
    'INSERT INTO messages (channel_id, user_id, content, imported_from, discord_message_id, thread_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(channelId, user, `message ${discordId}`, imported ? 'discord' : null, discordId, thread).lastInsertRowid;
  m.old = msg(ch.a, '700000000000000001');
  m.sub = msg(ch.s, '700000000000000002');
  m.loose = msg(ch.u, '700000000000000003');
  m.topic = msg(ch.f, '700000000000000010');
  m.topicReply = msg(ch.f, '700000000000000011', { thread: m.topic });
  m.root = msg(ch.a, '700000000000000020');
  m.reply = msg(ch.a, '700000000000000021', { thread: m.root });
  m.mine = msg(ch.a, null, { user: bob.id, imported: false });
  db.prepare("INSERT INTO ferry_message_map (haven_message_id, discord_message_id, discord_channel_id) VALUES (?, '700000000000000030', ?)").run(m.mine, C_A);

  // What the import did: every reaction under the admin who ran it.
  const react = db.prepare("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, '2026-10-29 12:00:00')");
  for (const e of ['👍', ':pepe:', ':gone:']) react.run(m.old, admin.id, e);
  db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(m.mine, bob.id, '🔥');
  db.prepare("INSERT INTO ferry_reactions (message_id, emoji, discord_user_id, name) VALUES (?, '👍', ?, 'left since')").run(m.old, U9);
});

test.after(async () => {
  try { db.close(); } catch { /* closed */ }
  await h.stop();
});

const one = (list) => list.map(c => `${c.discord_message_id}@${c.discord_channel_id}`).sort();

test('which Haven message is which Discord message', () => {
  assert.deepEqual(fr.havenCopies(db, '700000000000000001').map(c => c.id), [m.old], 'copied history');
  assert.deepEqual(fr.havenCopies(db, '700000000000000002').map(c => c.id), [m.sub], 'sub-channel, through its parent');
  assert.deepEqual(fr.havenCopies(db, '700000000000000003'), [], 'channel not paired');

  assert.deepEqual(one(fr.discordCopies(db, m.old)), [`700000000000000001@${C_A}`]);
  assert.deepEqual(one(fr.discordCopies(db, m.sub)), [`700000000000000002@${T_S}`]);
  assert.deepEqual(one(fr.discordCopies(db, m.topic)), ['700000000000000010@700000000000000010'], 'a topic\'s first message is in its post');
  assert.deepEqual(one(fr.discordCopies(db, m.topicReply)), ['700000000000000011@700000000000000010']);
  assert.deepEqual(one(fr.discordCopies(db, m.reply)), ['700000000000000021@700000000000000020'], 'a thread has its first message\'s id');
  assert.deepEqual(one(fr.discordCopies(db, m.mine)), [`700000000000000030@${C_A}`], 'what Ferry sent');
  assert.deepEqual(fr.discordCopies(db, m.loose), []);
  assert.equal(fr.discordCopies(db, m.old)[0].guild_id, G);

  db.prepare("INSERT INTO bazaar_ferry_chat_threads (root_message_id, channel_id, discord_thread_id) VALUES (?, ?, '799999999999999999')").run(m.root, ch.a);
  assert.deepEqual(one(fr.discordCopies(db, m.reply)), ['700000000000000021@799999999999999999'], 'a mapped thread wins');
  db.prepare('DELETE FROM bazaar_ferry_chat_threads WHERE root_message_id = ?').run(m.root);

  assert.equal(fr.sendsOut(db, ch.s), true);
  assert.equal(fr.sendsOut(db, ch.u), false);
  // The upstream entry points go through these.
  assert.deepEqual(ferryReactions.discordCopies(db, m.sub).length, 1);
});

test('the list of Discord channels and threads to read', () => {
  const ids = sync.targets(db).map(t => t.id);
  for (const id of [C_A, T_S, C_U, C_F, '700000000000000010', '700000000000000020']) assert.ok(ids.includes(id), id);
});

function discordMessage(id, reactions) { return { id, reactions }; }

test('history gets the real people, and the import\'s stand-ins go', async () => {
  const asked = [];
  const people = {
    '👍': [{ id: U1, username: 'one' }, { id: U2, global_name: 'Two' }, { id: BOT, username: 'bot' }],
    'pepe%3A900': [{ id: U3, username: 'three' }],
  };
  const reactors = async (code, type) => { asked.push(`${code}/${type}`); return type === 0 ? (people[decodeURIComponent(code)] || people[code] || []) : []; };
  const dmsg = discordMessage('700000000000000001', [
    { emoji: { id: null, name: '👍' }, count: 3, count_details: { normal: 3, burst: 0 }, me: true },
    { emoji: { id: '900', name: 'pepe' }, count: 1, count_details: { normal: 1, burst: 0 }, me: false },
    { emoji: { id: '901', name: 'gone' }, count: 2, count_details: { normal: 2, burst: 0 }, me: false },
  ]);
  const stats = {};
  const opts = { botId: BOT, isUsableEmoji, reactors, importerId: admin.id, artifactsBefore: '2026-11-19 00:00:00' };

  await sync.syncMessage(db, dmsg, { ...opts, dryRun: true }, stats);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').get(m.old).n, 3, 'a dry run changes nothing');

  await sync.syncMessage(db, dmsg, opts, stats);
  const rows = db.prepare('SELECT emoji, discord_user_id, name FROM ferry_reactions WHERE message_id = ? ORDER BY emoji, discord_user_id').all(m.old);
  assert.deepEqual(rows.map(r => `${r.emoji} ${r.discord_user_id} ${r.name}`).sort(), [
    `:pepe: ${U3} three`, `👍 ${U1} one`, `👍 ${U2} Two`,
  ].sort());
  const left = db.prepare('SELECT emoji, user_id FROM reactions WHERE message_id = ?').all(m.old);
  assert.deepEqual(left, [{ emoji: ':gone:', user_id: admin.id }], 'an emoji Haven has no match for stays as it was');

  // Shown to everyone: Haven's and Discord's, a linked person by their Haven name.
  db.prepare("INSERT INTO bazaar_discord_links (user_id, discord_id, discord_username, source) VALUES (?, ?, 'two', 'discord')").run(bob.id, U2);
  const shown = ferryReactions.listFor(db, m.old).map(r => r.username).sort();
  assert.ok(shown.includes('bob (Discord)'), JSON.stringify(shown));
  assert.ok(shown.includes('one (Discord)'));

  // Again: Ferry's rows already match Discord's counts, so Discord is not asked.
  asked.length = 0;
  await sync.syncMessage(db, dmsg, opts, {});
  assert.deepEqual(asked, []);
});

test('reactions made on Haven before get the bot\'s reaction on Discord', async () => {
  const reacted = [];
  const opts = { botId: BOT, isUsableEmoji, reactors: async () => [], importerId: admin.id, artifactsBefore: '2026-11-19 00:00:00', react: async (copy, emoji) => reacted.push(`${copy.id} ${emoji}`) };
  await sync.syncMessage(db, discordMessage('700000000000000030', []), opts, {});
  assert.deepEqual(reacted, [`${m.mine} 🔥`]);
  reacted.length = 0;
  await sync.syncMessage(db, discordMessage('700000000000000030', [{ emoji: { id: null, name: '🔥' }, count: 1, count_details: { normal: 1, burst: 0 }, me: true }]), opts, {});
  assert.deepEqual(reacted, [], 'already there');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').get(m.mine).n, 1, 'Haven\'s own reaction stays');
});

test('a sub-channel takes reactions from Discord now', () => {
  const changed = ferryReactions.fromDiscord(db, 'add', {
    message_id: '700000000000000002', user_id: U1, emoji: { id: null, name: '🎉' }, member: { nick: 'One' },
  }, { botId: BOT, isUsableEmoji });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].messageId, m.sub);
});
