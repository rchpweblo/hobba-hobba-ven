'use strict';

// Bizarre Bazaar fork: big data. Topics copied from Discord hold up to
// 48,000 replies and channels hundreds of thousands of messages.
//  - A client that cannot page (the Android app) gets the newest 1,000
//    replies of a topic, where the whole topic used to fail outright
//    (SQLite takes at most 32,766 "?" parameters).
//  - A blog topic still comes whole, and its lookups bind their lists as
//    one JSON array (src/bazaarSqlList.js), so it opens at any size.
//  - Channel history stays a page, however long the channel.
//
//   node --test test/bazaarBigData.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3631, 'bazaar-big-data');
const SLOW_MS = 20000; // a busy test machine; these answer in well under a second normally

test.before(() => h.start());
test.after(() => h.stop());

async function makeChannel(S, name) {
  const made = h.next(S, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === name));
  S.emit('create-channel', { name });
  return (await made).find((c) => c.name === name);
}

async function timed(promise) {
  const t0 = Date.now();
  const value = await promise;
  return { value, ms: Date.now() - t0 };
}

test('huge topics and channels', async (t) => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const S = await h.connect(admin.token);
  const big = await makeChannel(S, 'big');
  const blogs = await makeChannel(S, 'blogs');
  S.emit('enter-channel', { code: big.code });
  await wait(200);

  // Written straight to the database: sending this much would trip the flood limit.
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  const idOf = (code) => db.prepare('SELECT id FROM channels WHERE code = ?').get(code).id;
  const bigId = idOf(big.code);
  const blogId = idOf(blogs.code);
  const add = db.prepare("INSERT INTO messages (channel_id, user_id, content, thread_id, created_at) VALUES (?, ?, ?, ?, datetime('2025-01-01', ?))");
  let topic, blogTopic, firstComment, newestReply;
  db.transaction(() => {
    // 50,000 messages in the channel, a topic among them with 50,000 replies.
    for (let i = 1; i <= 50000; i++) add.run(bigId, bob.id, `chat ${i}`, null, `+${i} seconds`);
    topic = add.run(bigId, admin.id, 'the topic', null, '+50001 seconds').lastInsertRowid;
    for (let i = 1; i <= 50000; i++) newestReply = add.run(bigId, bob.id, `reply ${i}`, topic, `+${60000 + i} seconds`).lastInsertRowid;

    // A blog topic: three pieces of the post, then 33,000 comments (past the 32,766 limit).
    db.prepare('UPDATE channels SET is_forum = 1, forum_blog = 1 WHERE id = ?').run(blogId);
    blogTopic = add.run(blogId, admin.id, 'the post', null, '+1 seconds').lastInsertRowid;
    for (let i = 1; i <= 3; i++) add.run(blogId, admin.id, `piece ${i}`, blogTopic, `+${1 + i} seconds`);
    for (let i = 1; i <= 33000; i++) {
      const id = add.run(blogId, bob.id, `comment ${i}`, blogTopic, `+${10 + i} seconds`).lastInsertRowid;
      if (i === 1) firstComment = id;
    }
    const react = db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)');
    react.run(firstComment, admin.id, '👍');
    react.run(newestReply, admin.id, '🎉');
  })();
  db.close();
  topic = Number(topic); blogTopic = Number(blogTopic); firstComment = Number(firstComment); newestReply = Number(newestReply);

  await t.test('a client that cannot page gets the newest 1,000 replies', async () => {
    const got = h.next(S, 'thread-messages', (d) => d && d.parentId === topic && !d.before, SLOW_MS);
    S.emit('get-thread-messages', { parentId: topic });
    const { value: d, ms } = await timed(got);
    assert.ok(d, 'the topic opened');
    assert.ok(ms < SLOW_MS, `took ${ms} ms`);
    assert.equal(d.messages.length, 1000);
    assert.equal(d.hasMore, true, 'there is more than it was sent');
    assert.equal(d.messages[0].content, 'reply 49001', 'oldest of the newest 1,000 first');
    assert.equal(d.messages[999].content, 'reply 50000');
    assert.deepEqual(d.messages[999].reactions.map((r) => r.emoji), ['🎉']);
  });

  await t.test('a paging client still gets 150 at a time', async () => {
    const got = h.next(S, 'thread-messages', (d) => d && d.parentId === topic && d.messages.length === 150, SLOW_MS);
    S.emit('get-thread-messages', { parentId: topic, paged: true });
    const d = await got;
    assert.ok(d);
    assert.equal(d.hasMore, true);
    assert.equal(d.messages[149].content, 'reply 50000');
  });

  await t.test('a blog topic comes whole, at any size', async () => {
    const got = h.next(S, 'thread-messages', (d) => d && d.parentId === blogTopic, SLOW_MS * 2);
    S.emit('get-thread-messages', { parentId: blogTopic, paged: true });
    const { value: d, ms } = await timed(got);
    assert.ok(d, 'the blog topic opened (it failed past 32,766 replies before)');
    assert.ok(ms < SLOW_MS * 2, `took ${ms} ms`);
    assert.equal(d.blog, true);
    assert.equal(d.messages.length, 33003);
    assert.equal(d.hasMore, false);
    assert.deepEqual(d.messages.slice(0, 4).map((m) => [m.content, m.post_part]),
      [['piece 1', true], ['piece 2', true], ['piece 3', true], ['comment 1', false]]);
    assert.deepEqual(d.messages[3].reactions.map((r) => r.emoji), ['👍'], 'the oldest comment keeps its reaction');
    assert.equal(Object.keys(d.pieceVotes).length, 4, 'the post and its three pieces');
  });

  await t.test('channel history stays a page, however long the channel', async () => {
    const got = h.next(S, 'message-history', (d) => d && d.channelCode === big.code, SLOW_MS);
    S.emit('get-messages', { code: big.code, limit: 100 });
    const { value: d, ms } = await timed(got);
    assert.ok(d);
    assert.ok(ms < SLOW_MS, `took ${ms} ms`);
    assert.equal(d.messages.length, 100);
    assert.equal(d.messages[99].content, 'the topic', 'newest last');
  });
});
