'use strict';

// Bizarre Bazaar fork: Save a picture or video in another format
// (src/bazaarMediaConvert.js, public/js/modules/app-bazaar-save-formats.js).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const express = require('express');

const conv = require('../src/bazaarMediaConvert');
const tools = require('../src/mediaTools');
const { LocalStorage } = require('../src/storage/local');

const HAS_FFMPEG = tools.locateTools() || !!tools.toolPath('ffmpeg');

test('only plain upload paths are accepted', () => {
  assert.equal(conv.relFromSrc('/uploads/a.gif'), 'a.gif');
  assert.equal(conv.relFromSrc('https://chat.example/uploads/sub/b.mp4?mt=xyz'), 'sub/b.mp4');
  for (const bad of ['/uploads/../server.js', '/uploads/%2e%2e/x.gif', '/uploads/deleted-attachments/x.gif',
    '/uploads/Deleted-Attachments/x.gif', '/uploads/bot-audio/x.mp4', '/uploads/.env', '/uploads/DELETE~1/x.gif',
    '/uploads/a.gif.', '/other/a.gif', '/uploads/a%5C..%5Cb.gif', '', null]) {
    assert.equal(conv.relFromSrc(bad), null, String(bad));
  }
});

test('which conversions are offered', () => {
  assert.ok(conv.allowed('.gif', 'webp'));
  assert.ok(conv.allowed('.jpg', 'png'));
  assert.ok(conv.allowed('.mov', 'mp4'));
  assert.ok(conv.allowed('.mp4', 'webm'));
  assert.ok(!conv.allowed('.png', 'png'));
  assert.ok(!conv.allowed('.mp4', 'mp4'));
  assert.ok(!conv.allowed('.webp', 'png'), 'ffmpeg 4.4 cannot read animated WebP');
  assert.ok(!conv.allowed('.gif', 'mp4'));
  assert.ok(!conv.allowed('.jpg', 'exe'));
});

test('a stream that already fits the new container is copied, not re-encoded', () => {
  const info = conv.describe('  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080\n  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo');
  assert.deepEqual(info, { vcodec: 'h264', yuv420: true, acodec: 'aac' });
  const mp4 = conv.outputArgs('.mov', 'mp4', info).join(' ');
  assert.match(mp4, /-c:v copy/);
  assert.match(mp4, /-c:a copy/);
  const webm = conv.outputArgs('.mov', 'webm', info).join(' ');
  assert.match(webm, /libvpx-vp9/);
  assert.match(webm, /libopus/);
  assert.match(conv.outputArgs('.mov', 'mp4', { vcodec: 'hevc', yuv420: true, acodec: 'alac' }).join(' '), /libx264.*scale=trunc.*-c:a aac/);
  assert.match(conv.outputArgs('.gif', 'webp').join(' '), /libwebp_anim.*-loop 0/);
});

// ── The route, against a real ffmpeg ─────────────────────────

function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-convert-'));
  const app = express();
  conv.registerBazaarMediaConvertRoute(app, {
    storage: new LocalStorage(dir),
    verifyToken: (tok) => (tok === 'good' ? { id: 1 } : tok === 'other' ? { id: 2 } : null),
  });
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => resolve({ dir, srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const get = (base, q, tok = 'good') => fetch(`${base}/api/bazaar-convert?${new URLSearchParams(q)}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
const ffmpeg = (...args) => spawnSync(tools.toolPath('ffmpeg'), ['-v', 'error', '-y', ...args]);

test('the route refuses strangers, odd paths and missing files', async () => {
  const { srv, base } = await makeServer();
  try {
    assert.equal((await get(base, { src: '/uploads/a.gif', to: 'webp' }, null)).status, 401);
    assert.equal((await get(base, { src: '/uploads/../a.gif', to: 'webp' })).status, 400);
    assert.equal((await get(base, { src: '/uploads/a.gif', to: 'bmp' })).status, 400);
    if (HAS_FFMPEG) assert.equal((await get(base, { src: '/uploads/missing.gif', to: 'webp' })).status, 404);
  } finally { srv.close(); }
});

test('a GIF becomes an animated WebP, a video becomes WebM and MP4', { skip: !HAS_FFMPEG && 'no ffmpeg here' }, async () => {
  const { dir, srv, base } = await makeServer();
  try {
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=d=1:s=65x49:r=5', path.join(dir, 'anim.gif'));
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=d=1:s=65x49:r=10', '-f', 'lavfi', '-i', 'sine=d=1',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', path.join(dir, 'clip.mov'));

    let r = await get(base, { src: '/uploads/anim.gif', to: 'webp' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/webp');
    let buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(0, 4).toString(), 'RIFF');
    assert.equal(buf.subarray(8, 12).toString(), 'WEBP');
    assert.ok(buf.includes(Buffer.from('ANIM')), 'still animated');

    r = await get(base, { src: '/uploads/anim.gif', to: 'png' });
    buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(1, 4).toString(), 'PNG');

    // Odd width and height: re-encoding must even them out, not fail.
    r = await get(base, { src: '/uploads/clip.mov', to: 'webm' });
    assert.equal(r.status, 200);
    buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.readUInt32BE(0), 0x1A45DFA3, 'EBML (WebM) header');

    r = await get(base, { src: '/uploads/clip.mov', to: 'mp4' });
    assert.equal(r.status, 200);
    buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.subarray(4, 8).toString(), 'ftyp');

    // Not a video at all: a clean error, not a broken download.
    fs.writeFileSync(path.join(dir, 'fake.mp4'), 'not a video');
    r = await get(base, { src: '/uploads/fake.mp4', to: 'webm' });
    assert.equal(r.status, 422);
  } finally { srv.close(); }
});

// ── The menu ─────────────────────────────────────────────────

function loadClient() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/js/modules/app-bazaar-save-formats.js'), 'utf8');
  const strings = { original: 'Original', original_ext: 'Original ({{ext}})', png_still: 'PNG (still picture)', webp_animated: 'WebP (animated)' };
  const context = vm.createContext({
    module: { exports: {} },
    URL,
    window: { location: { origin: 'https://chat.example' } },
    t: (key, p = {}) => (strings[key.replace('bazaar_save.', '')] || key).replace(/\{\{(\w+)\}\}/g, (_, k) => p[k]),
  });
  vm.runInContext(source.replace(/^export default/m, 'module.exports ='), context);
  return context.module.exports;
}

test('the Save menu lists the original type first, then the others', () => {
  const m = loadClient();
  const labels = (list) => Array.from(list, c => `${c.fmt || '-'}:${c.label}`);
  assert.deepEqual(labels(m._bazaarImageSaveChoices.call(m, '/uploads/cat.jpeg')), ['-:Original (JPG)', 'png:PNG', 'webp:WebP']);
  assert.deepEqual(labels(m._bazaarImageSaveChoices.call(m, '/uploads/a.png')), ['-:Original (PNG)', 'webp:WebP']);
  assert.deepEqual(labels(m._bazaarImageSaveChoices.call(m, '/uploads/a.gif')), ['-:Original (GIF)', 'png:PNG (still picture)', 'webp:WebP (animated)']);
  assert.deepEqual(labels(m._bazaarImageSaveChoices.call(m, '/uploads/a.webp')), ['-:Original (WEBP)', 'png:PNG (still picture)']);
  // A GIF the server never had (an encrypted DM picture) can't stay animated.
  assert.deepEqual(labels(m._bazaarImageSaveChoices.call(m, '/uploads/a.gif', { dataset: { e2eSrc: '1' } })), ['-:Original (GIF)', 'png:PNG (still picture)']);
  assert.deepEqual(labels(m._bazaarVideoSaveChoices.call(m, '/uploads/clip.mov')), ['-:Original (MOV)', 'mp4:MP4', 'webm:WebM']);
  assert.deepEqual(labels(m._bazaarVideoSaveChoices.call(m, '/uploads/clip.mp4')), ['-:Original (MP4)', 'webm:WebM']);
  assert.deepEqual(labels(m._bazaarVideoSaveChoices.call(m, 'https://elsewhere.example/v.mp4')), ['-:Original (MP4)']);
  assert.equal(m._bazaarSaveName.call(m, 'My Clip.mov', 'webm'), 'My Clip.webm');
  assert.equal(m._bazaarSaveName.call(m, 'a/b:c', 'mp4'), 'abc.mp4');
});
