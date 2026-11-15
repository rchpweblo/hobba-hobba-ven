'use strict';

// Bizarre Bazaar fork: FxTwitter-style mirror links.
//
// People on Discord post X/Twitter links through mirrors (fixupx.com,
// vxtwitter.com and friends) because Discord unfurls those properly. Haven
// already makes a full X card for an x.com link (author, text, photos, video)
// through the fxtwitter API, so a mirror link is read as the x.com link it
// stands for. The admin's link allowlist decides as it does for x.com itself:
// nothing is fetched from the mirror host.

const MIRRORS = [
  'fxtwitter.com', 'fixupx.com', 'vxtwitter.com', 'fixvx.com', 'twittpr.com',
  'stupidpenisx.com', 'girlcockx.com',
];

const STATUS_PATH = /^\/[A-Za-z0-9_]{1,20}\/status(?:es)?\/\d+/;

function isMirrorHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return MIRRORS.some(m => h === m || h.endsWith('.' + m));
}

// The x.com address a mirror link stands for, or the link unchanged.
function toX(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return url; }
  if (!/^https?:$/.test(u.protocol) || !isMirrorHost(u.hostname)) return url;
  const m = u.pathname.match(STATUS_PATH);
  return m ? `https://x.com${m[0]}` : url;
}

module.exports = { toX, isMirrorHost, MIRRORS };
