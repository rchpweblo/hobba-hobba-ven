'use strict';

// Bizarre Bazaar fork: fixupx / vxtwitter links preview as the x.com post.

const test = require('node:test');
const assert = require('node:assert/strict');
const { toX, isMirrorHost } = require('../src/bazaarTwitterMirrors');
const { buildHavenContent } = require('../src/ferry');

test('mirror links stand for the x.com post', () => {
  assert.equal(toX('https://fixupx.com/AetiusRF/status/2121603854118576500'), 'https://x.com/AetiusRF/status/2121603854118576500');
  assert.equal(toX('https://vxtwitter.com/a_b/status/1/photo/1?s=20'), 'https://x.com/a_b/status/1');
  assert.equal(toX('https://d.fxtwitter.com/someone/statuses/42'), 'https://x.com/someone/statuses/42');
  assert.equal(toX('http://FIXVX.com/x/status/7'), 'https://x.com/x/status/7');
});

test('everything else is left alone', () => {
  for (const url of [
    'https://x.com/someone/status/1',
    'https://fixupx.com/someone',               // a profile, not a post
    'https://notfixupx.com/a/status/1',         // only the mirror itself or its subdomains
    'https://www.kkinstagram.com/reel/abc/',
    'not a link',
    '',
  ]) assert.equal(toX(url), url);
  assert.equal(isMirrorHost('fixupx.com.'), true);
  assert.equal(isMirrorHost('evilfixupx.com'), false);
});

test("an author-less message's rich embed is still read (bots and the upstream tests)", () => {
  const out = buildHavenContent({
    content: 'New upload!',
    embeds: [{ type: 'rich', url: 'https://www.youtube.com/watch?v=abc123', thumbnail: { url: 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg' } }],
  });
  assert.ok(out.includes('https://i.ytimg.com/vi/abc123/maxresdefault.jpg'), out);
});
