'use strict';

// Bizarre Bazaar fork: Discord's stickers in Haven.
//
// Upstream Ferry relays a sticker as a link to Discord's picture of it, and
// the importer leaves stickers out. Here a sticker Discord sends is copied
// into uploads/stickers/ once, as discord-<id>.png (or .gif), and the
// message carries that line, which Haven shows as a sticker. The guild's own
// stickers also go into Haven's sticker picker, in a "Discord" pack, the
// first time Ferry sees each one; one an admin later removes in Haven stays
// removed. Discord's Lottie stickers (its own animated set) have no picture
// Haven can show, so they become "*[sticker: name]*".
//
// bazaar_discord_stickers keeps each copy: discord_id -> filename, and
// whether it has been put in the picker.

const fs = require('fs');
const path = require('path');
const { UNPROCESSED_DIR } = require('./paths');

const MAX_BYTES = 2 * 1024 * 1024; // Discord's own cap is 512 KB
const TIMEOUT_MS = 30000;
const LOTTIE = 3;
const GIF = 4;

function migrateBazaarStickers(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bazaar_discord_stickers (
      discord_id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      name TEXT,
      in_picker INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

const validId = (id) => /^\d{1,25}$/.test(String(id || ''));
const extFor = (format) => (Number(format) === GIF ? 'gif' : 'png');
const discordUrl = (id, format) => `https://media.discordapp.net/stickers/${id}.${extFor(format)}`;
const lottieText = (name) => `*[sticker: ${String(name || 'sticker').replace(/[*_~`|[\]\r\n]/g, '').slice(0, 60) || 'sticker'}]*`;

function known(db, id) {
  return db.prepare('SELECT filename FROM bazaar_discord_stickers WHERE discord_id = ?').get(String(id)) || null;
}

/**
 * What a relayed message carries for one of Discord's sticker_items: the
 * copy when there is one, otherwise Discord's picture (copied later, see
 * src/ferry.js), or the name for a Lottie sticker.
 */
function lineFor(db, item) {
  if (!item || !validId(item.id)) return '';
  if (Number(item.format_type) === LOTTIE) return lottieText(item.name);
  try {
    const row = known(db, item.id);
    if (row) return `/uploads/stickers/${row.filename}`;
  } catch { /* no table yet: the link */ }
  return discordUrl(item.id, item.format_type);
}

// One download at a time per sticker.
const inflight = new Map();

/**
 * Copies one sticker into uploads/stickers/ (cleaned, as uploads are) and
 * records it. Returns its line, or null when it cannot be copied.
 */
function copy(db, { id, name, format }, { fetchImpl = fetch, admit = null } = {}) {
  if (!validId(id) || Number(format) === LOTTIE) return Promise.resolve(null);
  const row = known(db, id);
  if (row) return Promise.resolve(`/uploads/stickers/${row.filename}`);
  if (inflight.has(String(id))) return inflight.get(String(id));
  const job = (async () => {
    const filename = `discord-${id}.${extFor(format)}`;
    const res = await fetchImpl(discordUrl(id, format), { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !/^image\/(png|apng|gif|webp)/.test(res.headers.get('content-type') || '')) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return null;
    fs.mkdirSync(UNPROCESSED_DIR, { recursive: true });
    const tmp = path.join(UNPROCESSED_DIR, `sticker-${filename}`);
    fs.writeFileSync(tmp, bytes);
    await (admit || require('./privacyPass').admitFile)(tmp, `stickers/${filename}`);
    db.prepare('INSERT OR IGNORE INTO bazaar_discord_stickers (discord_id, filename, name) VALUES (?, ?, ?)')
      .run(String(id), filename, String(name || '').slice(0, 100) || null);
    return `/uploads/stickers/${filename}`;
  })().catch((err) => {
    console.warn('[ferry] Could not copy a Discord sticker:', err.message);
    return null;
  }).finally(() => inflight.delete(String(id)));
  inflight.set(String(id), job);
  return job;
}

// A picker name as Haven's sticker upload makes one, kept unique.
function pickerName(db, name) {
  const base = String(name || '').toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+|[_-]+$/g, '').slice(0, 36) || 'sticker';
  const taken = db.prepare('SELECT 1 FROM stickers WHERE name = ?');
  let pick = base;
  for (let n = 2; taken.get(pick); n++) pick = `${base}-${n}`;
  return pick;
}

/**
 * The guild's stickers (GUILD_CREATE, GUILD_STICKERS_UPDATE): each one not
 * seen before is copied and put in the picker's "Discord" pack. Returns how
 * many were added.
 */
async function syncGuild(db, stickers, opts = {}) {
  let added = 0;
  for (const s of Array.isArray(stickers) ? stickers : []) {
    if (!s || !validId(s.id) || Number(s.format_type) === LOTTIE) continue;
    const before = db.prepare('SELECT in_picker FROM bazaar_discord_stickers WHERE discord_id = ?').get(String(s.id));
    if (before && before.in_picker) continue;
    const line = await copy(db, { id: s.id, name: s.name, format: s.format_type }, opts);
    if (!line) continue;
    // One already in the library (a server template brings the guild's
    // stickers along) is not added a second time.
    if (!(await alreadyInLibrary(db, path.basename(line)))) {
      db.prepare('INSERT INTO stickers (name, pack_name, filename, uploaded_by) VALUES (?, ?, ?, NULL)')
        .run(pickerName(db, s.name), 'Discord', path.basename(line));
      added++;
    }
    db.prepare('UPDATE bazaar_discord_stickers SET in_picker = 1 WHERE discord_id = ?').run(String(s.id));
  }
  return added;
}

// Whether a sticker with the same picture is already in the picker.
async function alreadyInLibrary(db, filename) {
  const storage = require('./storage');
  const size = db.prepare('SELECT bytes FROM media_objects WHERE rel_path = ?').get(`stickers/${filename}`)?.bytes;
  if (!size) return false;
  const same = db.prepare(`SELECT s.filename FROM stickers s JOIN media_objects m ON m.rel_path = 'stickers/' || s.filename
    WHERE m.bytes = ? AND s.filename != ?`).all(size, filename);
  if (!same.length) return false;
  const mine = await storage.readBuffer(`stickers/${filename}`).catch(() => null);
  if (!mine) return false;
  for (const { filename: other } of same) {
    const theirs = await storage.readBuffer(`stickers/${other}`).catch(() => null);
    if (theirs && mine.equals(theirs)) return true;
  }
  return false;
}

// A sticker link in message text ("Copy link" on a sticker gives one).
const STICKER_LINK = /https:\/\/(?:media\.discordapp\.net|cdn\.discordapp\.com)\/stickers\/(\d{1,25})\.(png|gif|webp)(?:\?[^\s)<>"'\]|]*)?/g;

/** The sticker links in `content`, each with what to copy. */
function linksIn(content) {
  const out = [];
  for (const m of String(content || '').matchAll(STICKER_LINK)) {
    let name = null;
    try { name = new URL(m[0]).searchParams.get('name'); } catch { /* no name */ }
    out.push({ url: m[0], id: m[1], name, format: m[2] === 'gif' ? GIF : 1 });
  }
  return out;
}

module.exports = { migrateBazaarStickers, lineFor, copy, syncGuild, linksIn, lottieText, STICKER_LINK };
