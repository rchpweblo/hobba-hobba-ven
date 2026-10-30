'use strict';

// Bizarre Bazaar fork: the bubble showing who is in a voice channel that is
// out of sight in the channel list (app-bazaar-voice-bubble.js), run against
// a small stand-in for the page, the way test/codeBlocks.test.js runs client
// code.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function fakeElement(id = '') {
  const classes = new Set();
  return {
    id, style: {}, dataset: {}, title: '', innerHTML: '', attrs: {},
    classList: {
      add: (c) => classes.add(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); return classes.has(c); },
    },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
    set textContent(v) { this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
  };
}
const rect = (top, bottom, left = 0, right = 200) => ({ top, bottom, left, right, width: right - left, height: bottom - top });

// The channel list on screen spans y 100..400; each item gives its own rect,
// and a null one is hidden in a collapsed category.
function page(items) {
  const list = fakeElement('channel-list');
  list.getBoundingClientRect = () => rect(100, 900);
  list.closest = (sel) => (sel === '#channels-pane' ? { getBoundingClientRect: () => rect(100, 400) } : null);
  list.querySelector = (sel) => {
    const code = /data-code="([^"]+)"/.exec(sel)[1];
    if (!(code in items)) return null;
    const r = items[code];
    return { offsetParent: r ? {} : null, getBoundingClientRect: () => r };
  };
  const home = fakeElement('home-server');
  const body = { appended: [], appendChild(el) { this.appended.push(el); } };
  return {
    list, home, body,
    document: {
      body, head: { appendChild() {} },
      getElementById: (id) => ({ 'channel-list': list, 'home-server': home })[id] || null,
      createElement: () => fakeElement(),
      addEventListener() {},
      documentElement: { lang: 'en' },
      querySelectorAll: () => [],
    },
  };
}

function loadApp(dom) {
  const sandbox = {
    document: dom.document,
    window: { innerWidth: 1000, innerHeight: 800, addEventListener() {} },
    navigator: { languages: ['en'] },
    // Runs at once and returns 0, so the bubble never sees a frame still pending.
    requestAnimationFrame: (cb) => { cb(); return 0; },
    CSS: { escape: (s) => s },
    t: (key, p) => (p && p.count != null ? `${p.count} voice channels` : key.split('.').pop()),
    Intl, Date, Math, JSON, String, Array, Object, Map, Set, RegExp, Error, Number, console,
    setInterval: () => 0, clearInterval: () => {},
  };
  const methods = {};
  for (const name of ['app-utilities.js', 'app-context.js', 'app-bazaar-voice-bubble.js']) {
    const source = fs.readFileSync(path.join(ROOT, 'public/js/modules', name), 'utf8');
    const context = vm.createContext({ module: { exports: {} }, exports: {}, ...sandbox });
    vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context, { filename: name });
    Object.assign(methods, context.module.exports);
  }
  const app = Object.create(methods);
  app.channels = [
    { code: 'aaaa0001', name: 'general', is_dm: 0 },
    { code: 'aaaa0002', name: 'vidya', is_dm: 0 },
    { code: 'aaaa0003', name: 'no-mic', is_dm: 0 },
    { code: 'dddd0001', name: 'a call', is_dm: 1 },
  ];
  app.voiceCounts = {};
  app.voiceChannelUsers = {};
  app._lastOnlineUsers = [{ id: 1, username: 'Ted', avatar: '/uploads/ted.png' }, { id: 2, username: 'Noah' }];
  app.switchChannel = (code) => { app.opened = code; };
  app._bazaarSetupVoiceBubble();
  return app;
}
const inVoice = (app, code, users) => { app.voiceCounts[code] = users.length; app.voiceChannelUsers[code] = users; };

test('a voice channel scrolled above the list shows at the top, with faces', () => {
  const dom = page({ aaaa0001: rect(20, 50), aaaa0002: rect(150, 180) });
  const app = loadApp(dom);
  const [above, below] = dom.body.appended;
  inVoice(app, 'aaaa0001', [{ id: 1, username: 'Ted' }, { id: 2, username: 'Noah' }]);
  app._bazaarUpdateVoiceBubble();
  assert.equal(above.style.display, '');
  assert.equal(below.style.display, 'none');
  assert.match(above.innerHTML, /<img class="bz-vb-av" src="\/uploads\/ted\.png"/);
  assert.match(above.innerHTML, /<span class="bz-vb-av"[^>]*>N<\/span>/, 'a letter for someone without a picture');
  assert.match(above.innerHTML, /#general/);
  assert.equal(above.title, '#general: Ted, Noah');
  assert.equal(above.style.top, '106px', 'pinned to the top of the visible list');
  assert.ok(dom.home.classList.contains('bz-voice-live'), 'the server icon shows someone is in voice');
});

test('below the list or in a collapsed category: one bubble at the bottom; in view: none', () => {
  const dom = page({ aaaa0001: rect(150, 180), aaaa0002: rect(500, 530), aaaa0003: null });
  const app = loadApp(dom);
  const [above, below] = dom.body.appended;
  inVoice(app, 'aaaa0002', [{ id: 1, username: 'Ted' }]);
  inVoice(app, 'aaaa0003', [{ id: 2, username: 'Noah' }]);
  app._bazaarUpdateVoiceBubble();
  assert.equal(above.style.display, 'none');
  assert.equal(below.style.display, '');
  assert.match(below.innerHTML, /2 voice channels/);
  assert.equal(below.style.bottom, '406px', 'pinned to the bottom of the visible list');
  assert.equal(below.dataset.code, 'aaaa0002');

  // Clicking opens the channel.
  delete app.voiceCounts.aaaa0002; delete app.voiceCounts.aaaa0003;
  inVoice(app, 'aaaa0001', [{ id: 1, username: 'Ted' }]);
  app._bazaarUpdateVoiceBubble();
  assert.equal(above.style.display, 'none', 'a channel in view needs no bubble');
  assert.equal(below.style.display, 'none');
});

test('a DM call alone lights nothing, and names are escaped', () => {
  const dom = page({ aaaa0001: rect(20, 50) });
  const app = loadApp(dom);
  const [above] = dom.body.appended;
  inVoice(app, 'dddd0001', [{ id: 1, username: 'Ted' }]);
  app._bazaarUpdateVoiceBubble();
  assert.ok(!dom.home.classList.contains('bz-voice-live'), 'a private call is not announced');
  assert.equal(above.style.display, 'none');

  app._lastOnlineUsers = [];
  inVoice(app, 'aaaa0001', [{ id: 9, username: '<img src=x onerror=alert(1)>' }]);
  app._bazaarUpdateVoiceBubble();
  assert.doesNotMatch(above.innerHTML, /<img src=x/);
});
