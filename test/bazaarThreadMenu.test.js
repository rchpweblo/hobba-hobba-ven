'use strict';

// Bizarre Bazaar fork: replies in a thread do what channel messages do from
// their menu (public/js/modules/app-bazaar-thread-menu.js). The server side:
// a reply carries its official mark and its protection when the thread
// loads, protecting works on a reply, and bazaar:locate-message tells a
// link which thread a reply is in, and nothing to someone outside.
//
//   node --test test/bazaarThreadMenu.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3542, 'bazaar-thread-menu');

test.before(() => h.start());
test.after(() => h.stop());

test('a reply can be protected and made official, and a link finds its thread', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const B = await h.connect(bob.token);

  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'hall'));
  A.emit('create-channel', { name: 'hall' });
  const hall = (await made).find((c) => c.name === 'hall');
  for (const S of [A, B]) S.emit('join-channel', { code: hall.code });
  await wait(300);
  for (const S of [A, B]) S.emit('enter-channel', { code: hall.code });
  await wait(200);

  const got = h.next(A, 'new-message', (d) => d && d.message && d.message.content === 'the root');
  A.emit('send-message', { code: hall.code, content: 'the root' });
  const root = (await got).message.id;

  const db = new Database(path.join(h.dataDir, 'haven.db'));
  const hallId = db.prepare('SELECT id FROM channels WHERE code = ?').get(hall.code).id;
  const add = db.prepare('INSERT INTO messages (channel_id, user_id, content, thread_id) VALUES (?, ?, ?, ?)');
  const replies = [];
  db.transaction(() => { for (let i = 1; i <= 120; i++) replies.push(Number(add.run(hallId, admin.id, `reply ${i}`, root).lastInsertRowid)); })();
  const old = replies[4];
  const until = async (fn) => { for (let i = 0; i < 30; i++) { if (fn()) return true; await wait(100); } return false; };

  // Protect a reply: everyone in the channel hears of it.
  const heard = h.next(B, 'message-archived', (d) => d && d.messageId === old);
  A.emit('archive-message', { messageId: old });
  assert.ok(await heard, 'announced');
  assert.strictEqual(db.prepare('SELECT is_archived FROM messages WHERE id = ?').get(old).is_archived, 1);

  // Official: the author marks their own reply.
  const marked = h.next(B, 'message-highlight', (d) => d && d.messageId === old);
  A.emit('set-message-highlight', { messageId: old, on: true });
  assert.ok((await marked).highlight, 'announced with the mark');

  // Opening the thread at that reply: the page around it, carrying both.
  const page = h.next(A, 'thread-messages', (d) => d && d.parentId === root && d.around === old);
  A.emit('get-thread-messages', { parentId: root, paged: true, around: old });
  const loaded = await page;
  const row = loaded.messages.find((m) => m.id === old);
  assert.ok(row, 'the reply is on the page');
  assert.ok(row.is_archived, 'protected');
  assert.ok(row.highlight, 'official');
  assert.ok(!loaded.messages.find((m) => m.id === replies[5]).highlight, 'only that one');
  assert.ok(loaded.hasNewer, 'newer replies wait below');
  // Opening it there is reading it, as opening it at the end is.
  assert.ok(await until(() => {
    const r = db.prepare('SELECT last_read_reply_id AS n FROM thread_reads WHERE user_id = ? AND thread_id = ?').get(admin.id, root);
    return r && r.n === replies[replies.length - 1];
  }), 'read to the newest reply');

  // A protected reply cannot be deleted until it is unprotected.
  A.emit('delete-message', { messageId: old });
  await wait(300);
  assert.ok(db.prepare('SELECT 1 FROM messages WHERE id = ?').get(old), 'still there');
  const freed = h.next(B, 'message-unarchived', (d) => d && d.messageId === old);
  A.emit('unarchive-message', { messageId: old });
  assert.ok(await freed);

  // A link to a reply finds its thread; to a channel message, nothing.
  assert.deepStrictEqual(await h.ask(B, 'bazaar:locate-message', { messageId: old }), { code: hall.code, parentId: root });
  assert.deepStrictEqual(await h.ask(B, 'bazaar:locate-message', { messageId: root }), {});
  assert.deepStrictEqual(await h.ask(B, 'bazaar:locate-message', { messageId: 999999 }), {});

  // Someone outside the channel learns nothing.
  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').run(hallId, bob.id);
  assert.deepStrictEqual(await h.ask(B, 'bazaar:locate-message', { messageId: old }), {});
  db.close();
});
