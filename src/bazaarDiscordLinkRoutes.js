'use strict';
/**
 * Bizarre Bazaar fork: linking a Discord account for the Role Bot
 * (src/bazaarRoleBot.js). Mounted at /connect/discord, ahead of upstream's
 * /connect routes, and built the way their Spotify link is:
 *
 *   GET  /connect/discord?token=   names the Haven account; nothing happens
 *                                  until the person presses Continue
 *   POST /connect/discord/go       ties the link to this browser with a
 *                                  cookie, then sends it to Discord
 *   GET  /connect/discord/callback Discord says who they are; the Role Bot
 *                                  gives their roles and the page lists them
 *
 * The cookie matters more here than for Spotify: without it, someone could
 * press Continue for their own account and send Discord's consent link to a
 * moderator, whose roles would then land on the sender's account.
 *
 * Only the Discord user id and name are kept. Discord's access token is used
 * once, to ask who the person is, and dropped.
 */

const express = require('express');
const crypto = require('crypto');
const bot = require('./bazaarRoleBot');
const { baseUrl } = require('./connectRoutes');

const BIND_COOKIE = 'haven_discord_bind';
const BIND_MS = 10 * 60 * 1000;
const binds = new Map(); // sha256(connect token) -> { bind, at }
const keyOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bindCookie(req, value, maxAgeSec) {
  const secure = req.secure || req.protocol === 'https';
  return `${BIND_COOKIE}=${value}; Path=/connect/discord; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}
function takeBind(req, token) {
  const key = keyOf(token);
  const entry = binds.get(key);
  binds.delete(key);
  if (!entry || Date.now() - entry.at > BIND_MS) return false;
  const got = cookieValue(req, BIND_COOKIE);
  return got.length === entry.bind.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(entry.bind));
}
function fromThisSite(req) {
  const site = req.get('Sec-Fetch-Site');
  if (site) return site === 'same-origin';
  const origin = req.get('Origin');
  if (!origin) return false;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}
function connectUserId(token) {
  if (!token || typeof token !== 'string') return null;
  const { verifyToken } = require('./auth'); // at call time: auth.js loads after this file
  const decoded = verifyToken(token, { allowScoped: true });
  if (!decoded || decoded.scope !== 'connect' || decoded.provider !== 'discord') return null;
  return typeof decoded.id === 'number' ? decoded.id : null;
}

function page(res, status, title, inner, color = '#e6e6e6') {
  res.status(status).set('Cache-Control', 'no-store').set('X-Frame-Options', 'DENY')
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'")
    .type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:16px; box-sizing:border-box;
         background:#15161a; color:#e6e6e6; font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  .card { padding:28px 32px; background:#1d1f24; border:1px solid #2c2f36; border-radius:12px; max-width:460px; width:100%; }
  h1 { font-size:18px; margin:0 0 12px; color:${color}; }
  p { font-size:13px; margin:0 0 14px; color:#a1a1aa; line-height:1.5; }
  b { color:#e6e6e6; }
  ul { margin:0 0 14px; padding-left:20px; font-size:13px; line-height:1.6; max-height:50vh; overflow:auto; }
  li span { color:#a1a1aa; }
  button { font:inherit; padding:8px 20px; border-radius:8px; border:0; background:#5865f2; color:#fff; cursor:pointer; }
</style></head><body><div class="card">${inner}</div></body></html>`);
}
const failPage = (res, msg) => page(res, 400, "Couldn't link Discord",
  `<h1>✕ Couldn't link Discord</h1><p>${escapeHtml(msg)}</p><p>Close this window and try again from Haven.</p>`, '#f87171');

function resultPage(res, result) {
  const item = (r) => `<li>${escapeHtml(r.name)}${r.channels ? ` <span>in #${r.channels.map(escapeHtml).join(', #')}</span>` : ''}</li>`;
  const from = { discord: 'your roles in the Discord server', snapshot: 'the copy of your Discord roles taken when the server moved', extra: 'roles set aside for you' }[result.source];
  const body = result.given.length
    ? `<p>From ${from}, the Role Bot gave you:</p><ul>${result.given.map(item).join('')}</ul>`
    : `<p>${result.source === 'none' ? 'The Role Bot found no Bizarre Bazaar roles for this Discord account.' : 'You already had every role the Role Bot would give you.'}</p>`;
  page(res, 200, 'Discord linked', `<h1>🤖 Discord linked</h1>${body}<p>You can close this window and go back to Haven.</p>`, '#4ade80');
}

/** @param {object} opts.getDb () => db; opts.fetchImpl for tests. */
function createDiscordLinkRoutes({ getDb, fetchImpl = fetch } = {}) {
  const router = express.Router();
  const redirectUri = (req) => `${baseUrl(req)}/connect/discord/callback`;

  router.use((req, res, next) => {
    const db = getDb();
    if (!db || !bot.attached() || !bot.isConfigured(db)) return res.status(503).send('Discord linking is not set up on this server');
    req.db = db;
    next();
  });

  router.get('/', (req, res) => {
    const userId = connectUserId(req.query.token);
    const u = userId ? req.db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(userId) : null;
    if (!u) return res.status(401).send('Link session expired. Close this tab and try again from Haven.');
    const who = u.display_name && u.display_name !== u.username ? `${u.display_name} (${u.username})` : u.username;
    page(res, 200, 'Link Discord', `<h1>Link Discord</h1>
<p>Your Discord account will be linked to the Haven account <b>${escapeHtml(who)}</b>, and the Role Bot will give that account your Bizarre Bazaar roles. This happens once.</p>
<p>Only continue if that is you and you started this from Haven.</p>
<form method="post" action="/connect/discord/go"><input type="hidden" name="token" value="${escapeHtml(req.query.token)}"><button type="submit">Continue</button></form>`);
  });

  router.post('/go', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    if (!fromThisSite(req)) return res.status(403).send('Open the link from Haven and press Continue.');
    const token = req.body && req.body.token;
    if (!connectUserId(token)) return res.status(401).send('Link session expired. Close this tab and try again from Haven.');
    const bind = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    for (const [k, v] of binds) if (now - v.at > BIND_MS) binds.delete(k);
    binds.set(keyOf(token), { bind, at: now });
    res.set('Set-Cookie', bindCookie(req, bind, 600));
    const params = new URLSearchParams({
      client_id: bot.clientId(), response_type: 'code', redirect_uri: redirectUri(req),
      scope: 'identify', state: token, prompt: 'consent',
    });
    res.redirect(303, `https://discord.com/oauth2/authorize?${params}`);
  });

  router.get('/callback', async (req, res) => {
    const userId = connectUserId(req.query.state);
    if (!userId) return failPage(res, 'The link session expired.');
    const sameBrowser = takeBind(req, req.query.state);
    res.set('Set-Cookie', bindCookie(req, '', 0));
    if (!sameBrowser) return failPage(res, 'Finish the link in the same browser that pressed Continue.');
    if (req.query.error || !req.query.code) return failPage(res, 'Discord did not approve the link.');
    try {
      const tokenResp = await fetchImpl('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: bot.clientId(), client_secret: bot.clientSecret(), grant_type: 'authorization_code',
          code: String(req.query.code), redirect_uri: redirectUri(req),
        }),
      });
      if (!tokenResp.ok) {
        console.error('[role-bot] Discord token exchange failed:', tokenResp.status);
        return failPage(res, 'Discord did not accept the link.');
      }
      const tok = await tokenResp.json();
      const meResp = await fetchImpl('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (!meResp.ok) return failPage(res, 'Discord did not say who you are.');
      const me = await meResp.json();
      const memberRoles = await bot.fetchMemberRoles(req.db, String(me.id), fetchImpl);
      const result = bot.linkAndGrant(req.db, userId, { discordId: me.id, discordUsername: me.username, memberRoles });
      if (result.error) return failPage(res, result.error);
      bot.refreshAfterGrant(userId, { ...result, discordUsername: me.username });
      console.log(`[role-bot] user ${userId} linked Discord ${me.id} (${result.source}): ${result.given.length} role(s) given`);
      return resultPage(res, result);
    } catch (err) {
      console.error('[role-bot] link failed:', err.message);
      return failPage(res, 'Something went wrong while talking to Discord.');
    }
  });

  return router;
}

module.exports = { createDiscordLinkRoutes };
