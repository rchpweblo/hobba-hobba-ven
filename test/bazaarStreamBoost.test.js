'use strict';

// Bizarre Bazaar fork: the stream volume slider goes to 200%, but native
// <audio> playout (upstream's default for screen-share audio) stops at 100%.
// Past 100% the stream goes through a Web Audio gain node; back at or under
// 100% it returns to native playout.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const VOICE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');

function setup() {
  const store = new Map();
  const audioEl = {
    id: 'voice-audio-screen-5', volume: 1, srcObject: null, dataset: {},
    play: () => Promise.resolve(), setSinkId: () => Promise.resolve(),
  };
  const gains = [];
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    document: { getElementById: (id) => (id === 'voice-audio-screen-5' ? audioEl : null) },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date,
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  const voice = Object.create(context.module.exports.prototype);
  voice.screenGainNodes = new Map();
  voice.isDeafened = false;
  voice._ensureAudioCtx = () => {
    voice.audioCtx = {
      destination: {},
      createMediaStreamSource: () => ({ connect() {} }),
      createGain: () => {
        const g = { gain: { value: 1 }, connected: true, connect() {}, disconnect() { g.connected = false; } };
        gains.push(g);
        return g;
      },
    };
  };
  const stream = { id: 'stream' };
  voice._playScreenAudio(5, stream);
  return { voice, audioEl, gains, store };
}

test('up to 100% the stream plays natively, with no mixer', () => {
  const { voice, audioEl, gains } = setup();
  assert.equal(gains.length, 0);
  voice.setStreamVolume(5, 0.6);
  assert.equal(audioEl.volume, 0.6);
  assert.equal(voice.screenGainNodes.size, 0);
});

test('past 100% the mixer takes over and really is louder, then hands back', () => {
  const { voice, audioEl, gains } = setup();
  voice.setStreamVolume(5, 1.8);
  assert.equal(gains.length, 1, 'a gain node was built');
  assert.equal(gains[0].gain.value, 1.8);
  assert.equal(audioEl.volume, 0, 'the element is silent, so the audio is not doubled');

  voice.setStreamVolume('5', 1.5); // the tile passes ids as either type
  assert.equal(gains.length, 1, 'no second path');
  assert.equal(gains[0].gain.value, 1.5);

  voice.setStreamVolume(5, 0.9);
  assert.equal(gains[0].connected, false, 'the mixer path is taken down');
  assert.equal(voice.screenGainNodes.size, 0);
  assert.equal(audioEl.volume, 0.9);
});

test("the Debug opt-in still keeps the mixer at any volume", () => {
  const { voice, gains, store } = setup();
  store.set('screen_audio_webaudio', '1');
  voice.setStreamVolume(5, 0.5);
  assert.equal(gains.length, 1);
  assert.equal(gains[0].gain.value, 0.5);
});
