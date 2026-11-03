'use strict';

// Bizarre Bazaar fork: the right-click menu on a thread reply
// (public/js/modules/app-bazaar-thread-menu.js) offers what the channel's
// menu offers, as far as it fits a reply, gated the same way; and a link to
// a reply opens its thread at the reply.
//
//   node --test test/bazaarThreadMenuClient.test.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function makeApp({ userId = 2, isAdmin = false, perms = [], moderator = false } = {}) {
  const made = [];
  const document = {
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => {
      const el = { style: {}, innerHTML: '', addEventListener() {}, getBoundingClientRect: () => ({ right: 0, bottom: 0, width: 0, height: 0 }) };
      made.push(el);
      return el;
    },
    body: { appendChild() {} },
    addEventListener() {},
  };
  const context = vm.createContext({
    module: { exports: {} }, document, window: { innerWidth: 1000, innerHeight: 800, getSelection: () => null },
    t: (k) => k, setTimeout: (fn) => fn(), console,
  });
  vm.runInContext(read('public/js/modules/app-bazaar-thread-menu.js').replace(/^export default/m, 'module.exports ='), context);
  const calls = [];
  const app = Object.assign(Object.create(null), context.module.exports, {
    user: { id: userId, isAdmin },
    currentChannel: 'hall0001',
    _hasPerm: (p) => perms.includes(p),
    _canModerate: () => moderator,
    _hideMessageContextMenu() {},
    _channelBlocksPosting: () => false,
    _canShareChannelLink: () => true,
    _getMessageAttachments: () => [],
    _bazaarCanPinThread: () => isAdmin || perms.includes('pin_message'),
    _canSetMessageNsfw: () => false,
    _canHighlightMessages: () => isAdmin || perms.includes('highlight_messages'),
    _jumpToMessage: (...a) => calls.push(['jump', ...a]),
    _openThread: (id) => calls.push(['open', id, app._threadJumpTarget]),
    _bazaarJumpToThreadReply: (id) => calls.push(['inThread', id]),
  });
  const menuFor = (dataset) => {
    app._bazaarShowThreadMenu({ target: { closest: () => null }, clientX: 1, clientY: 1 }, { dataset: { msgId: '42', ...dataset } });
    const html = made[made.length - 1].innerHTML;
    return [...html.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]);
  };
  return { app, calls, menuFor };
}

test('your own reply: edit, reply, quote, react, link, official, delete', () => {
  const { menuFor } = makeApp({ perms: ['highlight_messages'] });
  assert.deepEqual(menuFor({ userId: '2' }), ['edit', 'reply', 'quote', 'react', 'copy-link', 'highlight-on', 'delete']);
});

test("someone else's reply, for a plain member: nothing of theirs to change", () => {
  const { menuFor } = makeApp();
  assert.deepEqual(menuFor({ userId: '9' }), ['reply', 'quote', 'react', 'copy-link']);
});

test('a protected reply has no Delete and no Edit; a moderator can unprotect it', () => {
  const { menuFor } = makeApp({ perms: ['archive_messages', 'pin_message'], moderator: true });
  const items = menuFor({ userId: '2', archived: '1', pinned: '1' });
  assert.ok(items.includes('unarchive') && items.includes('unpin'));
  assert.ok(!items.includes('delete') && !items.includes('edit'));
  assert.ok(menuFor({ userId: '9' }).includes('archive'));
});

test('no Thread and no Select messages on a reply', () => {
  const { menuFor } = makeApp({ isAdmin: true });
  const items = menuFor({ userId: '9' });
  assert.ok(!items.includes('thread') && !items.includes('select-messages'));
});

test('a link to a reply opens its thread at the reply; anything else jumps in the channel', () => {
  const answer = { value: null };
  const { app, calls } = makeApp();
  app.socket = { timeout: () => ({ emit: (ev, data, cb) => { assert.equal(ev, 'bazaar:locate-message'); cb(null, answer.value); } }) };
  answer.value = { code: 'hall0001', parentId: 7 };
  app._bazaarJumpToReply(42);
  assert.deepEqual(calls.splice(0), [['jump', 7, true], ['open', 7, 42]]);
  answer.value = {};
  app._bazaarJumpToReply(43);
  assert.deepEqual(calls.splice(0), [['jump', 43, true]]);
  answer.value = { code: 'other001', parentId: 7 }; // not this channel's
  app._bazaarJumpToReply(44);
  assert.deepEqual(calls.splice(0), [['jump', 44, true]]);
});

test('the hooks are in place', () => {
  assert.match(read('public/js/modules/app-messages.js'), /if \(!bzLocated && this\._bazaarJumpToReply\) return this\._bazaarJumpToReply\(msgId\);/);
  assert.match(read('public/js/modules/app-threads.js'), /this\._bazaarDressThreadReply\?\.\(el, msg\);[^\n]*\n  target\.appendChild\(el\);/);
  assert.match(read('public/js/modules/app-threads.js'), /bzAround \? \{ parentId, paged: true, around: bzAround \}/);
  assert.match(read('public/js/app.js'), /this\._bazaarSetupThreadMenu\(\);/);
});
