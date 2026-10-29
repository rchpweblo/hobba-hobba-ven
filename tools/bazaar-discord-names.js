#!/usr/bin/env node
'use strict';
// Bizarre Bazaar fork: look up the names behind the Discord codes in copied
// history (<@id>, <@&id>, <#id>), through the Ferry bot, so the client can
// show them (src/bazaarDiscordRefs.js).
const path = require('path');

const USAGE = `Usage:
  node tools/bazaar-discord-names.js --data <dir> --guild <id> [--refresh] [--dry-run]

Finds every Discord code in Haven's messages that Haven cannot name by itself
and asks Discord for the name, once:
  person   their nickname in that server, else their Discord name
  role     the role's name in that server
  channel  the channel's or thread's name, unless @everyone cannot see it
People who linked Discord, roles in the Role Bot's rules and channels copied
into Haven are named by Haven itself and are not looked up.
--refresh  look up every name again, not only the missing ones
--data     Haven's data folder (the one holding haven.db).`;

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const API = 'https://discord.com/api/v10';
const VIEW_CHANNEL = 1n << 10n;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const dataDir = arg('--data'), guild = arg('--guild');
  if (!dataDir || !/^\d{5,25}$/.test(guild || '')) { console.error(USAGE); process.exit(2); }
  process.env.HAVEN_DATA_DIR = path.resolve(dataDir);
  const dry = process.argv.includes('--dry-run'), refresh = process.argv.includes('--refresh');
  const Database = require('better-sqlite3');
  const db = new Database(path.join(process.env.HAVEN_DATA_DIR, 'haven.db'), { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const refs = require('../src/bazaarDiscordRefs');
  refs.migrateBazaarDiscordRefs(db);
  const token = (db.prepare("SELECT value FROM server_settings WHERE key = 'ferry_bot_token'").get() || {}).value;
  if (!token) throw new Error('no Ferry bot token is set');

  // Waits out Discord's rate limit; null for a 403 or 404.
  const api = async (p) => {
    for (let tries = 0; ; tries++) {
      const r = await fetch(API + p, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 && tries < 5) { const j = await r.json().catch(() => ({})); await sleep(Math.ceil((j.retry_after || 2) * 1000)); continue; }
      if (r.status === 403 || r.status === 404) return null;
      if (!r.ok) throw new Error(`Discord answered ${r.status} for ${p}`);
      return r.json();
    }
  };

  const wanted = { user: new Set(), role: new Set(), channel: new Set() };
  for (const { content } of db.prepare("SELECT content FROM messages WHERE content LIKE '%<@%' OR content LIKE '%<#%'").iterate()) {
    const found = refs.idsIn(content);
    for (const k of Object.keys(wanted)) for (const id of found[k]) wanted[k].add(id);
  }
  const known = refs.refsFor(db);
  const named = { user: known.users, role: known.roles, channel: known.channels };
  const todo = {};
  for (const k of Object.keys(wanted)) {
    // Haven's own names (a link, a mapped role, a copied channel) never need a lookup.
    todo[k] = [...wanted[k]].filter(id => !named[k][id] || (refresh && !named[k][id].userId && !named[k][id].roleId && !named[k][id].channelId));
    console.log(`${k}s: ${wanted[k].size} in messages, ${todo[k].length} to look up`);
  }
  if (dry) return;
  const counts = { user: 0, role: 0, channel: 0 }, missing = { user: 0, role: 0, channel: 0 };
  const save = (kind, id, name) => { if (refs.saveName(db, kind, id, name)) counts[kind]++; else missing[kind]++; };

  if (todo.role.length) {
    const byId = new Map(((await api(`/guilds/${guild}/roles`)) || []).map(r => [String(r.id), r.name]));
    for (const id of todo.role) save('role', id, byId.get(id) || '');
  }

  for (const id of todo.user) {
    const member = await api(`/guilds/${guild}/members/${id}`);
    let name = member && (member.nick || (member.user && (member.user.global_name || member.user.username)));
    if (!name) { const u = await api(`/users/${id}`); name = u && (u.global_name || u.username); }
    save('user', id, name || '');
    await sleep(50);
  }

  if (todo.channel.length) {
    const list = (await api(`/guilds/${guild}/channels`)) || [];
    const byId = new Map(list.map(c => [String(c.id), c]));
    // Channels @everyone cannot see keep their names to themselves.
    const hidden = (c) => (c.permission_overwrites || []).some(o => String(o.id) === guild && (BigInt(o.deny || 0) & VIEW_CHANNEL));
    for (const id of todo.channel) {
      let c = byId.get(id);
      if (!c) { c = await api(`/channels/${id}`); await sleep(50); }
      const parent = c && c.parent_id ? byId.get(String(c.parent_id)) : null;
      const isThread = c && (c.type === 10 || c.type === 11 || c.type === 12);
      const secret = !c || c.type === 12 || hidden(c) || (isThread && parent && hidden(parent)) || (c.guild_id && String(c.guild_id) !== guild);
      save('channel', id, secret ? '' : c.name || '');
    }
  }
  console.log(`saved names: ${JSON.stringify(counts)}; no name found: ${JSON.stringify(missing)}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
