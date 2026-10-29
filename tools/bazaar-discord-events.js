#!/usr/bin/env node
'use strict';
// Bizarre Bazaar fork: copy a Discord server's scheduled events into Haven's
// events (src/bazaarEvents.js), through the Ferry bot.
const path = require('path');
const fs = require('fs');

const USAGE = `Usage:
  node tools/bazaar-discord-events.js --data <dir> --guild <id> [--as <admin username>] [--tz <IANA zone>] [--dry-run]

Copies every scheduled event of that Discord server that is not copied yet:
name, description, times, repeat, cover image and place. A voice or stage
event goes in the Haven channel linked to that Discord channel
(channels.discord_channel_id), so link the channels first. People Interested
on Discord are remembered by Discord id and become Interested here when they
link Discord for the Role Bot (at once, for anyone already linked).
--as     who the events are created by (default: the first admin)
--tz     the zone repeats keep their wall-clock time in (default: that
         person's Haven time zone setting)
--data   Haven's data folder (the one holding haven.db and uploads/).`;

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const API = 'https://discord.com/api/v10';

// Discord's recurrence rule to Haven's repeat (frequency: 0 yearly, 1 monthly, 2 weekly, 3 daily).
function repeatOf(rule) {
  if (!rule) return 'none';
  const { frequency: f, interval: n = 1 } = rule;
  if (f === 2 && n === 1) return 'weekly';
  if (f === 2 && n === 2) return 'biweekly';
  if (f === 1 && n === 1 && Array.isArray(rule.by_n_weekday) && rule.by_n_weekday.length === 1) return 'monthly';
  if (f === 0 && n === 1) return 'yearly';
  if (f === 3 && n === 1 && Array.isArray(rule.by_weekday) && [0, 1, 2, 3, 4].every((d) => rule.by_weekday.includes(d)) && rule.by_weekday.length === 5) return 'weekdays';
  return null;
}

async function main() {
  const dataDir = arg('--data'), guild = arg('--guild');
  if (!dataDir || !/^\d{5,25}$/.test(guild || '')) { console.error(USAGE); process.exit(2); }
  process.env.HAVEN_DATA_DIR = path.resolve(dataDir);
  const dry = process.argv.includes('--dry-run');
  const Database = require('better-sqlite3');
  const db = new Database(path.join(process.env.HAVEN_DATA_DIR, 'haven.db'), { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  const events = require('../src/bazaarEvents');
  const time = require('../src/bazaarEventTime');
  events.migrateBazaarEvents(db);

  const as = arg('--as');
  const creator = as
    ? db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE AND is_admin = 1').get(as)
    : db.prepare('SELECT id, username FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
  if (!creator) throw new Error(as ? `no admin named ${as}` : 'no admin account');
  const pref = db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = 'timezone'").get(creator.id);
  const tz = arg('--tz') || (pref && pref.value);
  if (!time.validZone(tz)) throw new Error(`no usable time zone (got ${tz || 'none'}): pass --tz, e.g. --tz America/Los_Angeles`);
  const token = (db.prepare("SELECT value FROM server_settings WHERE key = 'ferry_bot_token'").get() || {}).value;
  if (!token) throw new Error('no Ferry bot token is set');
  const api = async (p) => {
    const r = await fetch(API + p, { headers: { Authorization: `Bot ${token}` } });
    if (!r.ok) throw new Error(`Discord answered ${r.status} for ${p}`);
    return r.json();
  };

  const list = await api(`/guilds/${guild}/scheduled-events`);
  console.log(`${list.length} scheduled event(s) on Discord; repeats keep ${tz} time; created by ${creator.username}${dry ? '; dry run' : ''}`);
  for (const e of list) {
    const tag = `"${e.name}"`;
    if (db.prepare('SELECT 1 FROM bazaar_events WHERE discord_event_id = ?').get(e.id)) { console.log(`- ${tag}: already copied`); continue; }
    if (e.status !== 1 && e.status !== 2) { console.log(`- ${tag}: skipped, it has ended or was cancelled`); continue; }
    const repeat = repeatOf(e.recurrence_rule);
    if (!repeat) { console.log(`- ${tag}: skipped, its repeat (${JSON.stringify(e.recurrence_rule)}) has no Haven equivalent`); continue; }
    let channelId = null, location = null;
    if (e.entity_type === 3) location = String((e.entity_metadata && e.entity_metadata.location) || 'Somewhere else').slice(0, 100);
    else {
      const ch = db.prepare('SELECT id, name FROM channels WHERE discord_channel_id = ? AND is_dm = 0').get(String(e.channel_id));
      if (!ch) { console.log(`- ${tag}: skipped, Discord channel ${e.channel_id} is not linked to a Haven channel yet`); continue; }
      channelId = ch.id;
    }
    const startAt = Date.parse(e.scheduled_start_time);
    const endAt = e.scheduled_end_time ? Date.parse(e.scheduled_end_time) : null;
    const seriesStart = e.recurrence_rule && e.recurrence_rule.start ? Date.parse(e.recurrence_rule.start) : startAt;
    const people = [];
    for (let after = '0'; ;) {
      const page = await api(`/guilds/${guild}/scheduled-events/${e.id}/users?limit=100&after=${after}`);
      people.push(...page.map((u) => String(u.user.id)));
      if (page.length < 100) break;
      after = page[page.length - 1].user.id;
    }
    let image = null;
    if (e.image && !dry) {
      const r = await fetch(`https://cdn.discordapp.com/guild-events/${e.id}/${e.image}.png?size=1024`);
      const buf = r.ok ? Buffer.from(await r.arrayBuffer()) : null;
      if (buf && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && buf.length <= 4 * 1024 * 1024) {
        const name = `bazaar-event-${e.id}-${String(e.image).replace(/[^a-z0-9]/gi, '').slice(0, 10)}.png`;
        const staged = path.join(process.env.HAVEN_DATA_DIR, 'uploads', `.staged-${name}`);
        fs.writeFileSync(staged, buf);
        await require('../src/storage').admit(name, staged, { contentType: 'image/png' });
        image = `/uploads/${name}`;
      } else console.log(`  ${tag}: the cover image could not be fetched, so it was left out`);
    }
    const where = channelId ? `#${db.prepare('SELECT name FROM channels WHERE id = ?').get(channelId).name}` : location;
    if (dry) { console.log(`- ${tag}: would be copied (${where}, ${repeat}, ${people.length} interested${e.image ? ', with a cover' : ''})`); continue; }
    db.transaction(() => {
      const id = db.prepare(`INSERT INTO bazaar_events (name, description, channel_id, location, start_at, end_at, series_start, repeat, tz, image, created_by, created_at, discord_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(String(e.name).slice(0, 100), String(e.description || '').slice(0, 1000), channelId, location,
        startAt, endAt, seriesStart, repeat, tz, image, creator.id, Date.now(), e.id).lastInsertRowid;
      const ins = db.prepare('INSERT OR IGNORE INTO bazaar_event_discord_interest (event_id, discord_id) VALUES (?, ?)');
      people.forEach((d) => ins.run(id, d));
    })();
    let linkedNow = 0;
    const hasLinks = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bazaar_discord_links'").get();
    if (hasLinks) {
      for (const d of people) {
        const link = db.prepare("SELECT user_id FROM bazaar_discord_links WHERE discord_id = ? AND source != 'none'").get(d);
        if (link) linkedNow += events.claimDiscordInterest(db, link.user_id, d);
      }
    }
    console.log(`- ${tag}: copied (${where}, ${repeat}, ${people.length} interested on Discord, ${linkedNow} already here${image ? ', with its cover' : ''})`);
  }
  db.close();
  console.log('Open Haven again (or reload it) to see copied events.');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
