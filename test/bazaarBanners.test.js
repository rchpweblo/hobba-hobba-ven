'use strict';

// Bizarre Bazaar fork: banner messages (src/bazaarBanners.js). One per
// channel and one per forum post; set by whoever manages the channel's
// settings, or by a post's starter for their own post; gone with its post.
//
//   node --test test/bazaarBanners.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3541, 'bazaar-banners');

test.before(() => h.start());
test.after(() => h.stop());

test('banners hang on channels and forum posts, set only by those who may', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);

  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'hall'));
  A.emit('create-channel', { name: 'hall' });
  const hall = (await made).find((c) => c.name === 'hall');
  const made2 = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'board'));
  A.emit('create-channel', { name: 'board', isForum: true });
  const board = (await made2).find((c) => c.name === 'board');
  for (const S of [A, B]) {
    S.emit('join-channel', { code: hall.code });
    S.emit('join-channel', { code: board.code });
  }
  await wait(300);
  for (const S of [A, B]) S.emit('enter-channel', { code: hall.code });
  await wait(200);

  const getBanner = (S, code, topicId) => {
    const got = h.next(S, 'bazaar:banner', (d) => d && d.code === code && (d.topicId == null ? null : d.topicId) === (topicId == null ? null : topicId), 1500);
    S.emit('bazaar:get-banner', topicId == null ? { code } : { code, topicId });
    return got;
  };

  // None yet.
  const none = await getBanner(A, hall.code);
  assert.strictEqual(none.banner, null);
  assert.strictEqual(none.canSet, true, 'the admin may');
  assert.strictEqual((await getBanner(B, hall.code)).canSet, false, 'a member may not');

  // A member cannot set one, and a banner needs a message.
  assert.ok((await h.ask(B, 'bazaar:set-banner', { code: hall.code, body: 'mine now' })).error);
  assert.ok((await h.ask(A, 'bazaar:set-banner', { code: hall.code, title: 'Rules', body: '   ' })).error);

  // The admin sets one: everyone in the channel sees it.
  const seen = h.next(B, 'bazaar:banner', (d) => d && d.code === hall.code && d.banner);
  assert.deepStrictEqual(await h.ask(A, 'bazaar:set-banner', { code: hall.code, title: 'Rules', body: 'Be kind.\n/uploads/rules.png', nsfw: true }), { ok: true });
  const live = await seen;
  assert.strictEqual(live.topicId, null);
  assert.strictEqual(live.banner.title, 'Rules');
  assert.strictEqual(live.banner.body, 'Be kind.\n/uploads/rules.png');
  assert.strictEqual(live.banner.nsfw, true);
  assert.strictEqual(live.banner.setBy, 'admin');

  // Setting again changes the one banner.
  assert.deepStrictEqual(await h.ask(A, 'bazaar:set-banner', { code: hall.code, body: 'Be very kind.' }), { ok: true });
  const after = (await getBanner(B, hall.code)).banner;
  assert.strictEqual(after.title, '');
  assert.strictEqual(after.body, 'Be very kind.');
  assert.strictEqual(after.nsfw, false);

  // Someone outside the channel is told nothing.
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  const hallId = db.prepare('SELECT id FROM channels WHERE code = ?').get(hall.code).id;
  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(hallId, carol.id);
  assert.strictEqual(await getBanner(C, hall.code), null);

  // Forum posts: the starter may set their own post's banner, not another's.
  const sendTopic = async (S, content) => {
    const got = h.next(S, 'new-message', (d) => d && d.message && d.message.content === content);
    S.emit('send-message', { code: board.code, content, title: content });
    return (await got).message.id;
  };
  for (const S of [A, B]) S.emit('enter-channel', { code: board.code });
  await wait(200);
  const bobPost = await sendTopic(B, 'bob asks');
  const adminPost = await sendTopic(A, 'admin says');
  assert.strictEqual((await getBanner(B, board.code, bobPost)).canSet, true);
  assert.deepStrictEqual(await h.ask(B, 'bazaar:set-banner', { code: board.code, topicId: bobPost, title: 'Answer', body: 'See the third reply.' }), { ok: true });
  assert.ok((await h.ask(B, 'bazaar:set-banner', { code: board.code, topicId: adminPost, body: 'nope' })).error);
  assert.strictEqual((await getBanner(A, board.code, bobPost)).banner.title, 'Answer');
  assert.strictEqual((await getBanner(A, board.code)).banner, null, 'the forum itself has none');

  // A chat channel's thread has none.
  const root = Number(db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'a chat line')").run(hallId, admin.id).lastInsertRowid);
  assert.ok((await h.ask(A, 'bazaar:set-banner', { code: hall.code, topicId: root, body: 'thread banner' })).error);

  // Removing: announced as null.
  const cleared = h.next(B, 'bazaar:banner', (d) => d && d.code === hall.code && d.banner === null);
  assert.deepStrictEqual(await h.ask(A, 'bazaar:clear-banner', { code: hall.code }), { ok: true });
  assert.ok(await cleared, 'removal announced');
  assert.ok((await h.ask(B, 'bazaar:clear-banner', { code: board.code, topicId: adminPost })).error);

  // A post's banner goes with the post.
  db.prepare('DELETE FROM messages WHERE id = ?').run(bobPost);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM bazaar_banners WHERE scope = ?").get(`t:${bobPost}`).n, 0);
  db.close();
});
