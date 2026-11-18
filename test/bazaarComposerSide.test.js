'use strict';

// Bizarre Bazaar fork: "Right side message buttons" (Settings > Layout &
// Density > Message Box). On by default for new accounts only.
//
//   node --test test/bazaarComposerSide.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');
const { createHarness } = require('./socketServerHarness');
const side = require('../src/bazaarComposerSide');

const PORT = 3632;
const h = createHarness(PORT, 'bazaar-composer-side');

test.before(() => h.start());
test.after(() => h.stop());

function sessionInfo(token) {
  const s = io(`http://localhost:${PORT}`, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => {
    s.once('session-info', (info) => { s.close(); res(info); });
    s.on('connect_error', rej);
  });
}

test('session-info says whether the account is new', async () => {
  const fresh = await h.register('newcomer');
  assert.equal((await sessionInfo(fresh.token)).bazaarNewAccount, true);

  const old = await h.register('oldtimer');
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.prepare("UPDATE users SET created_at = '2026-11-08 06:46:48' WHERE id = ?").run(old.id);
  db.close();
  assert.equal((await sessionInfo(old.token)).bazaarNewAccount, false);
});

test('the cut-off date', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, created_at TEXT)');
  db.prepare('INSERT INTO users VALUES (1, ?), (2, ?), (3, NULL)').run('2026-11-17 23:59:59', side.NEW_ACCOUNTS_SINCE);
  assert.equal(side.isNewAccount(db, 1), false);
  assert.equal(side.isNewAccount(db, 2), true);
  assert.equal(side.isNewAccount(db, 3), false, 'no date: as before');
  assert.equal(side.isNewAccount(db, 99), false);
});

// ── The client ───────────────────────────────────────────────

function loadClient(stored) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-bazaar-composer-side.js'), 'utf8');
  const store = new Map(stored === undefined ? [] : [['haven_bz_right_buttons', stored]]);
  const attrs = new Set();
  const listeners = {};
  const box = { checked: false, addEventListener: (ev, fn) => { listeners[ev] = fn; } };
  const context = vm.createContext({
    module: { exports: {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    document: {
      getElementById: (id) => (id === 'bz-right-buttons' ? box : null),
      createElement: () => ({}),
      head: { appendChild: () => {} },
      documentElement: { toggleAttribute: (a, on) => (on ? attrs.add(a) : attrs.delete(a)) },
    },
  });
  vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context);
  const handlers = {};
  const app = Object.assign({ socket: { on: (ev, fn) => { handlers[ev] = fn; } } }, context.module.exports);
  app._bazaarSetupComposerSide();
  return { store, box, listeners, handlers, on: () => attrs.has('data-bz-right-buttons') };
}

test('a browser that never had it set follows the account, once', () => {
  const c = loadClient();
  assert.equal(c.on(), false, 'left until the server answers');
  c.handlers['session-info']({ bazaarNewAccount: true });
  assert.equal(c.on(), true);
  assert.equal(c.box.checked, true);
  assert.equal(c.store.get('haven_bz_right_buttons'), 'true');
  c.handlers['session-info']({ bazaarNewAccount: false });
  assert.equal(c.on(), true, 'decided once; a reconnect changes nothing');

  const old = loadClient();
  old.handlers['session-info']({ bazaarNewAccount: false });
  assert.equal(old.on(), false);
  assert.equal(old.store.get('haven_bz_right_buttons'), 'false');

  const olderServer = loadClient();
  olderServer.handlers['session-info']({});
  assert.equal(olderServer.store.has('haven_bz_right_buttons'), false, 'no answer: asks again next time');
});

test('the member\'s own choice wins', () => {
  const c = loadClient('false');
  c.handlers['session-info']({ bazaarNewAccount: true });
  assert.equal(c.on(), false);
  c.box.checked = true;
  c.listeners.change();
  assert.equal(c.on(), true);
  assert.equal(c.store.get('haven_bz_right_buttons'), 'true');
  assert.equal(loadClient('true').on(), true);
});
