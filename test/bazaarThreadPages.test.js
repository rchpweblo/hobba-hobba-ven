'use strict';

// Bizarre Bazaar fork: get-thread-messages sends a thread a page at a time,
// newest first, and `before` asks for the page older than a reply. Topics
// copied from Discord run to tens of thousands of replies.
//
//   node --test test/bazaarThreadPages.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3533, 'bazaar-thread-pages');

test.before(() => h.start());
test.after(() => h.stop());

test('a long thread comes in pages of 150, oldest page last', async () => {
  const admin = await h.register('admin');
  const S = await h.connect(admin.token);
  const made = h.next(S, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'long'));
  S.emit('create-channel', { name: 'long' });
  const long = (await made).find((c) => c.name === 'long');
  S.emit('enter-channel', { code: long.code });
  await wait(200);
  const parent = h.next(S, 'new-message', (d) => d && d.message && d.message.content === 'the topic');
  S.emit('send-message', { code: long.code, content: 'the topic' });
  const parentId = (await parent).message.id;

  // 320 replies, written straight to the database: sending them would trip the flood limit.
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  const channelId = db.prepare('SELECT id FROM channels WHERE code = ?').get(long.code).id;
  const add = db.prepare("INSERT INTO messages (channel_id, user_id, content, thread_id, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))");
  db.transaction(() => { for (let i = 1; i <= 320; i++) add.run(channelId, admin.id, `reply ${i}`, parentId, `-${1000 - i} seconds`); })();
  db.close();

  const page = async (before) => {
    const got = h.next(S, 'thread-messages', (d) => d && d.parentId === parentId && (d.before || null) === (before || null));
    S.emit('get-thread-messages', before ? { parentId, before } : { parentId, paged: true });
    return got;
  };
  const ids = (d) => d.messages.map((m) => m.content);

  const first = await page();
  assert.equal(first.messages.length, 150);
  assert.equal(first.hasMore, true);
  assert.equal(first.messages[0].content, 'reply 171', 'the newest 150, oldest of them first');
  assert.equal(first.messages[149].content, 'reply 320');

  const second = await page(first.messages[0].id);
  assert.deepStrictEqual(ids(second).slice(0, 2), ['reply 21', 'reply 22']);
  assert.equal(second.messages[149].content, 'reply 170', 'carries straight on from the first page');
  assert.equal(second.hasMore, true);

  const third = await page(second.messages[0].id);
  assert.equal(third.messages.length, 20);
  assert.equal(third.messages[0].content, 'reply 1');
  assert.equal(third.hasMore, false, 'nothing older');

  // An id that is not a reply in this thread pages nothing.
  const stray = await page(parentId);
  assert.equal(stray.messages.length, 0);
  assert.equal(stray.hasMore, false);

  // A client that does not ask for pages (an older app) gets the whole thread, as upstream.
  const whole = h.next(S, 'thread-messages', (d) => d && d.parentId === parentId && !d.before && d.messages.length === 320);
  S.emit('get-thread-messages', { parentId });
  const all = await whole;
  assert.equal(all.hasMore, false);
  assert.equal(all.messages[0].content, 'reply 1');
});
