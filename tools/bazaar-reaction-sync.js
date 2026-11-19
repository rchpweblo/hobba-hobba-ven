#!/usr/bin/env node
'use strict';
// Bizarre Bazaar fork: bring the reactions on messages already in Haven in
// line with Discord's (src/bazaarReactionSync.js). Safe to run while Haven
// runs, safe to stop and run again: it carries on where it stopped.

const path = require('path');
const fs = require('fs');

const USAGE = `Usage:
  node tools/bazaar-reaction-sync.js --data <dir> --importer <username> [options]

--data      Haven's data folder (the one holding haven.db)
--importer  the admin who ran the Discord import; the reactions the import
            put under their name are replaced by the real people
--state     where progress is kept (default: bazaar-reaction-sync.json here)
--workers   channels read at the same time (default 4)
--only      one Discord channel or thread id
--pages     stop each channel after this many pages of 100 (for a trial)
--dry-run   read Discord and count what would change, change nothing
Run again with the same --state to carry on after a stop.`;

const API = process.env.FERRY_TEST_DISCORD_API ? `${process.env.FERRY_TEST_DISCORD_API}/api/v10` : 'https://discord.com/api/v10';
const UA = 'DiscordBot (https://github.com/ancsemi/Haven, 1.0)';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function arg(argv, name, dflt = null) {
  const at = argv.indexOf(name);
  return at > -1 && argv[at + 1] !== undefined ? argv[at + 1] : dflt;
}

async function main() {
  const argv = process.argv.slice(2);
  const dataDir = arg(argv, '--data');
  const importer = arg(argv, '--importer');
  if (!dataDir || !importer) { console.error(USAGE); process.exit(2); }
  const dryRun = argv.includes('--dry-run');
  const workers = Math.max(1, Math.min(8, parseInt(arg(argv, '--workers', '4'), 10) || 4));
  const only = arg(argv, '--only');
  const maxPages = parseInt(arg(argv, '--pages', '0'), 10) || 0;
  const statePath = path.resolve(arg(argv, '--state', 'bazaar-reaction-sync.json'));

  const Database = require('better-sqlite3');
  const db = new Database(path.join(path.resolve(dataDir), 'haven.db'), { fileMustExist: true, readonly: dryRun });
  db.pragma('busy_timeout = 10000');
  const sync = require('../src/bazaarReactionSync');
  const ferryReactions = require('../src/ferryReactions');
  const { isUsableEmoji } = require('../src/builtinEmojis');

  const who = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(importer);
  if (!who) throw new Error(`no user named ${importer}`);
  const tokenRow = db.prepare("SELECT value FROM server_settings WHERE key = 'ferry_bot_token'").get();
  const token = tokenRow && String(tokenRow.value || '').trim();
  if (!token) throw new Error('Ferry has no bot token');

  const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  let state = { startedAt: nowSql(), done: {}, cursor: {}, stats: {} };
  if (!dryRun && fs.existsSync(statePath)) state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const stats = state.stats;
  const save = () => { if (!dryRun) fs.writeFileSync(statePath, JSON.stringify(state)); };

  // ── Discord, within its limits ──
  const buckets = new Map();
  let globalUntil = 0;
  async function api(method, p, key) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const b = buckets.get(key);
      const until = Math.max(globalUntil, b && b.remaining <= 0 ? b.resetAt : 0);
      if (until > Date.now()) await sleep(until - Date.now() + 50);
      let res;
      try {
        res = await fetch(API + p, { method, headers: { Authorization: `Bot ${token}`, 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      } catch (err) {
        stats.networkErrors = (stats.networkErrors || 0) + 1;
        await sleep(3000 * (attempt + 1));
        continue;
      }
      stats.requests = (stats.requests || 0) + 1;
      const rem = res.headers.get('x-ratelimit-remaining');
      const after = res.headers.get('x-ratelimit-reset-after');
      if (rem !== null && after !== null) buckets.set(key, { remaining: Number(rem), resetAt: Date.now() + Number(after) * 1000 });
      if (res.status === 429) {
        stats.limited = (stats.limited || 0) + 1;
        let j = {};
        try { j = await res.json(); } catch { /* no body */ }
        const ms = Math.ceil((Number(j.retry_after) || 1) * 1000);
        if (j.global) globalUntil = Date.now() + ms;
        else buckets.set(key, { remaining: 0, resetAt: Date.now() + ms });
        continue;
      }
      if (res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      if (res.status === 204) return null;
      let body = null;
      try { body = await res.json(); } catch { /* empty */ }
      if (!res.ok) {
        const err = new Error((body && body.message) || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return body;
    }
    throw new Error(`Discord kept refusing ${method} (gave up)`);
  }

  const me = await api('GET', '/users/@me', 'me');
  const botId = String(me.id);
  const guildIds = [...new Set(db.prepare('SELECT DISTINCT guild_id FROM ferry_links WHERE is_active = 1').all().map(r => String(r.guild_id)))];
  const guildEmojis = new Map();
  for (const g of guildIds) {
    const list = await api('GET', `/guilds/${g}/emojis`, `emojis:${g}`).catch(() => []);
    guildEmojis.set(g, new Map((list || []).filter(e => e && e.name && e.id).map(e => [e.name.toLowerCase(), e])));
  }

  const warned = new Set();
  const react = async (copy, emoji) => {
    for (const c of ferryReactions.discordCopies(db, copy.id)) {
      const code = ferryReactions.discordEmojiFor(emoji, guildEmojis.get(String(c.guild_id)));
      if (!code) continue;
      try {
        await api('PUT', `/channels/${c.discord_channel_id}/messages/${c.discord_message_id}/reactions/${code}/@me`, `react:${c.discord_channel_id}`);
      } catch (err) {
        if (!warned.has(c.discord_channel_id)) { warned.add(c.discord_channel_id); console.warn(`could not react in Discord channel ${c.discord_channel_id}: ${err.message}`); }
      }
    }
  };

  let list = sync.targets(db);
  if (only) list = list.filter(t => t.id === only);
  const total = list.reduce((n, t) => n + t.size, 0);
  console.log(`${list.length} Discord channels and threads, about ${total} messages. ${dryRun ? 'Dry run: nothing changes.' : `Progress in ${statePath}.`}`);
  const queue = list.filter(t => !state.done[t.id]);
  const opts = { botId, isUsableEmoji, importerId: who.id, artifactsBefore: state.startedAt, dryRun, react };

  async function work() {
    for (let t = queue.shift(); t; t = queue.shift()) {
      let before = state.cursor[t.id] || null;
      let pages = 0;
      try {
        for (;;) {
          const page = await api('GET', `/channels/${t.id}/messages?limit=100${before ? `&before=${before}` : ''}`, `msgs:${t.id}`);
          if (!Array.isArray(page) || !page.length) break;
          for (const m of page) {
            stats.scanned = (stats.scanned || 0) + 1;
            const reactors = async (code, type) => {
              const users = [];
              let afterId = null;
              for (;;) {
                const part = await api('GET', `/channels/${t.id}/messages/${m.id}/reactions/${code}?limit=100&type=${type}${afterId ? `&after=${afterId}` : ''}`, `rx:${t.id}`);
                if (!Array.isArray(part) || !part.length) break;
                users.push(...part);
                if (part.length < 100) break;
                afterId = part[part.length - 1].id;
              }
              return users;
            };
            try {
              await sync.syncMessage(db, m, { ...opts, reactors }, stats);
            } catch (err) {
              stats.messageErrors = (stats.messageErrors || 0) + 1;
              if ((stats.messageErrors || 0) <= 20) console.warn(`message ${m.id} in ${t.label}: ${err.message}`);
            }
          }
          before = page.reduce((lo, m) => (BigInt(m.id) < BigInt(lo) ? m.id : lo), page[0].id);
          state.cursor[t.id] = before;
          save();
          if (page.length < 100 || (maxPages && ++pages >= maxPages)) break;
        }
        if (!maxPages) state.done[t.id] = 'ok';
      } catch (err) {
        state.done[t.id] = `${err.status || ''} ${err.message}`.trim();
        stats.targetErrors = (stats.targetErrors || 0) + 1;
        console.warn(`${t.label}: ${err.message}`);
      }
      delete state.cursor[t.id];
      save();
    }
  }

  const t0 = Date.now();
  const report = () => {
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`[${new Date().toISOString()}] ${mins} min: ${Object.keys(state.done).length}/${list.length} done, ${stats.scanned || 0} read (~${total ? Math.round(100 * (stats.scanned || 0) / total) : 0}%), `
      + `${stats.messages || 0} with Haven copies, +${stats.added || 0} -${stats.removed || 0} Discord reactions, ${stats.artifactsRemoved || 0} import stand-ins gone (${stats.artifactsKept || 0} kept), `
      + `${stats.botReactions || 0} bot reactions, ${stats.requests || 0} requests, ${stats.limited || 0} rate-limited`);
  };
  const timer = setInterval(report, 60000);
  await Promise.all(Array.from({ length: workers }, work));
  clearInterval(timer);
  report();
  const left = db.prepare(`SELECT COUNT(*) AS n FROM reactions r JOIN messages m ON m.id = r.message_id
    WHERE m.imported_from = 'discord' AND r.user_id = ? AND r.created_at < ?`).get(who.id, state.startedAt).n;
  console.log(`Import stand-ins still in place: ${left} (messages gone from Discord, emoji Haven has no match for, or not reached).`);
  const failed = Object.entries(state.done).filter(([, v]) => v !== 'ok');
  if (failed.length) console.log(`Not read: ${failed.length} channel(s)/thread(s): ${failed.slice(0, 10).map(([k, v]) => `${k} (${v})`).join(', ')}${failed.length > 10 ? ', ...' : ''}`);
  db.close();
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
