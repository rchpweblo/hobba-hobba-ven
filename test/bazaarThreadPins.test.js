'use strict';

// Bizarre Bazaar fork: a reply in a forum topic or thread is pinned in that
// topic's own list (bazaarPinReply and bazaar:get-thread-pins in
// src/socketHandlers/messages.js), apart from the channel's pins.
//
//   node --test test/bazaarThreadPins.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3537, 'bazaar-thread-pins');

test.before(() => h.start());
test.after(() => h.stop());

test('replies are pinned per topic, apart from the channel', async () => {
  const admin = await h.register('admin');
  const S = await h.connect(admin.token);
  const made = h.next(S, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'topics'));
  S.emit('create-channel', { name: 'topics' });
  const topics = (await made).find((c) => c.name === 'topics');
  const made2 = h.next(S, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'elsewhere'));
  S.emit('create-channel', { name: 'elsewhere' });
  const elsewhere = (await made2).find((c) => c.name === 'elsewhere');

  S.emit('enter-channel', { code: topics.code });
  await wait(200);
  const sendTop = async (content) => {
    const got = h.next(S, 'new-message', (d) => d && d.message && d.message.content === content);
    S.emit('send-message', { code: topics.code, content });
    return (await got).message.id;
  };
  const topicA = await sendTop('topic A');
  const topicB = await sendTop('topic B');

  const db = new Database(path.join(h.dataDir, 'haven.db'));
  const channelId = db.prepare('SELECT id FROM channels WHERE code = ?').get(topics.code).id;
  const add = db.prepare('INSERT INTO messages (channel_id, user_id, content, thread_id) VALUES (?, ?, ?, ?)');
  const repliesA = [];
  db.transaction(() => { for (let i = 1; i <= 260; i++) repliesA.push(Number(add.run(channelId, admin.id, `A reply ${i}`, topicA).lastInsertRowid)); })();
  const replyB = Number(add.run(channelId, admin.id, 'B reply', topicB).lastInsertRowid);

  // Pinned from somewhere else: the channel comes from the message.
  S.emit('enter-channel', { code: elsewhere.code });
  await wait(200);
  S.emit('pin-message', { messageId: repliesA[0] });
  assert.ok(await (async () => { for (let i = 0; i < 30; i++) { if (db.prepare('SELECT 1 FROM pinned_messages WHERE message_id = ?').get(repliesA[0])) return true; await wait(100); } return false; })(), 'pinned');

  const thread = async (parentId) => {
    const got = h.next(S, 'thread-messages', (d) => d && d.parentId === parentId && !d.before);
    S.emit('get-thread-messages', { parentId }); // the whole topic
    return got;
  };
  const a = await thread(topicA);
  assert.strictEqual(a.pinCount, 1);
  assert.strictEqual(a.messages.find((m) => m.id === repliesA[0]).pinned, true, 'the reply carries its pin');
  assert.ok(!a.messages.find((m) => m.id === repliesA[1]).pinned);

  const listOf = async (parentId) => {
    const got = h.next(S, 'bazaar:thread-pins', (d) => d && d.parentId === parentId);
    S.emit('bazaar:get-thread-pins', { parentId });
    return (await got).pins.map((p) => p.id);
  };
  assert.deepStrictEqual(await listOf(topicA), [repliesA[0]], "in topic A's list");
  assert.deepStrictEqual(await listOf(topicB), [], "not in topic B's");

  // The topic itself pinned is the channel's pin, as upstream has it.
  S.emit('enter-channel', { code: topics.code });
  await wait(200);
  S.emit('pin-message', { messageId: topicB });
  await wait(300);
  const chPins = h.next(S, 'pinned-messages', (d) => d && d.channelCode === topics.code);
  S.emit('get-pinned-messages', { code: topics.code });
  assert.deepStrictEqual((await chPins).pins.map((p) => p.id), [topicB], "the channel's list has the topic, not the reply");
  assert.deepStrictEqual(await listOf(topicB), [], 'and the topic is not in its own list');
  const history = h.next(S, 'message-history', (d) => d && d.channelCode === topics.code);
  S.emit('get-messages', { code: topics.code });
  assert.strictEqual((await history).pinnedCount, 1, "the channel's pin count leaves the reply out");

  // 250 a topic, as Discord allows a thread, each topic its own.
  const pinRow = db.prepare('INSERT INTO pinned_messages (message_id, channel_id, pinned_by) VALUES (?, ?, ?)');
  db.transaction(() => { for (const id of repliesA.slice(1, 250)) pinRow.run(id, channelId, admin.id); })();
  const full = h.next(S, 'error-msg', (m) => /250-pin limit/.test(String(m)));
  S.emit('pin-message', { messageId: repliesA[250] });
  assert.ok(await full, 'topic A is full');
  S.emit('pin-message', { messageId: replyB });
  assert.deepStrictEqual(await (async () => { await wait(300); return listOf(topicB); })(), [replyB], 'topic B still takes pins');
  // The channel's own 50 count no reply pins: with 250 of them it still pins a topic.
  S.emit('enter-channel', { code: topics.code });
  await wait(200);
  S.emit('pin-message', { messageId: topicA });
  assert.ok(await (async () => { for (let i = 0; i < 30; i++) { if (db.prepare('SELECT 1 FROM pinned_messages WHERE message_id = ?').get(topicA)) return true; await wait(100); } return false; })(), 'the channel still takes pins');

  // Someone without the pin permission cannot.
  const bob = await h.register('bob');
  const B = await h.connect(bob.token);
  const refused = h.next(B, 'error-msg', (m) => /permission to pin/.test(String(m)));
  B.emit('pin-message', { messageId: repliesA[255] });
  assert.ok(await refused);

  // Unpinning takes it off the list.
  S.emit('unpin-message', { messageId: repliesA[0] });
  await wait(300);
  assert.ok(!(await listOf(topicA)).includes(repliesA[0]), 'unpinned');
  db.close();
  S.close(); B.close();
});
