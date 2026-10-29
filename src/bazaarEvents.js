'use strict';
/**
 * Bizarre Bazaar fork: scheduled events, the way Discord has them.
 *
 * An event has a name, a description, a start and an optional end, a cover
 * image, and a place: a Haven channel (usually voice) or somewhere else. It
 * can repeat (src/bazaarEventTime.js). People mark themselves Interested.
 *
 * Who may do what (role permissions, checked in the event's channel, so a
 * role held in one channel covers events there):
 *   create_events  create events, and edit, start, end or cancel their own
 *   manage_events  do all of that to anyone's events
 * The admin may do everything. Events in a channel are seen only by its
 * members; events somewhere else by everyone but guests.
 *
 * How an event runs:
 *   - a channel event waits for someone allowed to press Start; everyone
 *     Interested then gets a pop-up with a Join button, and a push
 *     notification when they are away;
 *   - an event somewhere else starts and ends at its times by itself;
 *   - a live event ends at its end time; one with no end time ends after
 *     30 minutes with nobody in its voice channel, or after 24 hours;
 *   - a channel event nobody started is missed 12 hours after its start;
 *   - when a repeating event ends or is missed it moves to its next date and
 *     keeps its Interested list; a one-off is done.
 */

const time = require('./bazaarEventTime');

const MIN = 60000, HOUR = 60 * MIN;
const IDLE_END_MS = 30 * MIN, MAX_LIVE_MS = 24 * HOUR, MISSED_AFTER_MS = 12 * HOUR;
const IMAGE_RE = /^\/uploads\/[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

function migrateBazaarEvents(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bazaar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      location TEXT,
      start_at INTEGER NOT NULL,
      end_at INTEGER,
      series_start INTEGER NOT NULL,
      repeat TEXT NOT NULL DEFAULT 'none',
      tz TEXT NOT NULL DEFAULT 'UTC',
      status TEXT NOT NULL DEFAULT 'scheduled',
      image TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      discord_event_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS bazaar_event_interest (
      event_id INTEGER NOT NULL REFERENCES bazaar_events(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS bazaar_event_discord_interest (
      event_id INTEGER NOT NULL REFERENCES bazaar_events(id) ON DELETE CASCADE,
      discord_id TEXT NOT NULL,
      PRIMARY KEY (event_id, discord_id)
    );
  `);
}

// ── Server-level handles (set once by socketHandlers/index.js) ──────────
let h = null;
let timer = null;
const lastVoice = new Map(); // event id -> last time someone was in its voice channel
function attach(handles) {
  h = handles;
  if (!timer) {
    timer = setInterval(() => { try { sweep(); } catch (err) { console.warn('[events] sweep failed:', err.message); } }, MIN);
    timer.unref?.();
    setTimeout(() => { try { sweep(); } catch (err) { console.warn('[events] sweep failed:', err.message); } }, 5000).unref?.();
  }
}
function detach() { if (timer) clearInterval(timer); timer = null; h = null; lastVoice.clear(); }

// ── Who may see and do what ─────────────────────────────────────────────
const getEvent = (db, id) => db.prepare('SELECT * FROM bazaar_events WHERE id = ?').get(Number(id)) || null;
const channelOf = (db, id) => (id ? db.prepare('SELECT id, code, name, voice_enabled, is_dm FROM channels WHERE id = ?').get(id) : null);
const isMember = (db, userId, channelId) => !!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channelId, userId);

function canSee(db, user, ev) {
  if (!user) return false;
  if (!ev.channel_id) return !user.isGuest;
  return !!user.isAdmin || isMember(db, user.id, ev.channel_id);
}
function canCreateIn(perm, user, channelId) {
  if (user.isAdmin) return true;
  if (user.isGuest) return false;
  return perm(user.id, 'create_events', channelId) || perm(user.id, 'manage_events', channelId);
}
function canManage(perm, user, ev) {
  if (user.isAdmin) return true;
  if (user.isGuest) return false;
  return perm(user.id, 'manage_events', ev.channel_id) || (ev.created_by === user.id && perm(user.id, 'create_events', ev.channel_id));
}
// Where this person may put a new event: their channels where they may
// create one, and whether they may put one somewhere else.
function createOptions(db, perm, user) {
  const chans = user.isAdmin
    ? db.prepare('SELECT id, code, name, voice_enabled, parent_channel_id FROM channels WHERE is_dm = 0 ORDER BY name COLLATE NOCASE').all()
    : db.prepare(`SELECT c.id, c.code, c.name, c.voice_enabled, c.parent_channel_id FROM channels c JOIN channel_members cm ON cm.channel_id = c.id
        WHERE cm.user_id = ? AND c.is_dm = 0 ORDER BY c.name COLLATE NOCASE`).all(user.id);
  const channels = user.isGuest ? [] : chans.filter((c) => canCreateIn(perm, user, c.id))
    .map((c) => ({ id: c.id, code: c.code, name: c.name, voice: !!c.voice_enabled }));
  return { channels, elsewhere: canCreateIn(perm, user, null) };
}
// For the cover upload: may this person create an event anywhere at all?
function canCreateAnywhere(db, userId) {
  const u = db.prepare('SELECT is_admin, is_guest FROM users WHERE id = ?').get(userId);
  if (!u || u.is_guest) return false;
  if (u.is_admin) return true;
  return !!db.prepare(`SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.permission IN ('create_events', 'manage_events') AND rp.allowed = 1 LIMIT 1`).get(userId)
    || !!db.prepare(`SELECT 1 FROM user_role_perms WHERE user_id = ? AND permission IN ('create_events', 'manage_events') AND allowed = 1 LIMIT 1`).get(userId);
}

// ── Reading ─────────────────────────────────────────────────────────────
function serialize(db, perm, user, ev) {
  const ch = channelOf(db, ev.channel_id);
  const creator = ev.created_by ? db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(ev.created_by) : null;
  return {
    id: ev.id, name: ev.name, description: ev.description, status: ev.status,
    channel: ch ? { id: ch.id, code: ch.code, name: ch.name, voice: !!ch.voice_enabled } : null,
    location: ev.location || null,
    startAt: ev.start_at, endAt: ev.end_at, repeat: ev.repeat, tz: ev.tz, startedAt: ev.started_at,
    image: ev.image || null,
    createdBy: creator ? { id: creator.id, name: creator.display_name || creator.username } : null,
    interested: db.prepare('SELECT COUNT(*) AS n FROM bazaar_event_interest WHERE event_id = ?').get(ev.id).n,
    me: !!db.prepare('SELECT 1 FROM bazaar_event_interest WHERE event_id = ? AND user_id = ?').get(ev.id, user.id),
    canManage: canManage(perm, user, ev),
  };
}

function listFor(db, perm, user) {
  return db.prepare("SELECT * FROM bazaar_events WHERE status IN ('scheduled', 'active') ORDER BY status = 'active' DESC, start_at, id").all()
    .filter((ev) => canSee(db, user, ev))
    .map((ev) => serialize(db, perm, user, ev));
}

function interestedNames(db, user, id) {
  const ev = getEvent(db, id);
  if (!ev || !canSee(db, user, ev)) return null;
  return db.prepare(`SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name FROM bazaar_event_interest i JOIN users u ON u.id = i.user_id
    WHERE i.event_id = ? ORDER BY name COLLATE NOCASE`).all(ev.id);
}

// ── Writing ─────────────────────────────────────────────────────────────
function userZone(db, userId) {
  try {
    const row = db.prepare("SELECT value FROM user_preferences WHERE user_id = ? AND key = 'timezone'").get(userId);
    return row && time.validZone(row.value) ? row.value : null;
  } catch { return null; } // no preferences table in a bare test database
}

/** Checks a create or edit from a client. Returns { error } or the clean fields. */
function cleanInput(db, input, now = Date.now()) {
  if (!input || typeof input !== 'object') return { error: 'Nothing to save' };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 100) return { error: 'An event needs a name of up to 100 characters' };
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length > 1000) return { error: 'The description can be up to 1000 characters' };
  const channelId = input.channelId == null || input.channelId === '' ? null : Number(input.channelId);
  if (channelId !== null && !(Number.isInteger(channelId) && channelId > 0)) return { error: 'Pick a channel' };
  const location = channelId ? null : (typeof input.location === 'string' ? input.location.trim() : '');
  if (!channelId && (!location || location.length > 100)) return { error: 'Say where the event is (up to 100 characters)' };
  // Whole minutes, as Discord has them.
  const minute = (v) => Math.floor(Number(v) / MIN) * MIN;
  const startAt = minute(input.startAt), endAt = input.endAt == null || input.endAt === '' ? null : minute(input.endAt);
  if (!Number.isSafeInteger(startAt) || startAt > now + 5 * 365 * 24 * HOUR) return { error: 'Pick a start time' };
  if (endAt !== null && !(Number.isSafeInteger(endAt) && endAt > startAt && endAt - startAt <= 31 * 24 * HOUR)) return { error: 'The end must be after the start, and within 31 days of it' };
  if (!channelId && endAt === null) return { error: 'An event somewhere else needs an end time' };
  const repeat = time.REPEATS.includes(input.repeat) ? input.repeat : 'none';
  const image = input.image == null || input.image === '' ? null : String(input.image);
  if (image && !IMAGE_RE.test(image)) return { error: 'The cover image must be uploaded to Haven' };
  if (channelId) {
    const ch = channelOf(db, channelId);
    if (!ch || ch.is_dm) return { error: 'That channel no longer exists' };
  }
  return { name, description, channelId, location, startAt, endAt, repeat, image, tz: time.validZone(input.tz) ? input.tz : 'UTC' };
}

/** Create (no id) or edit an event. Returns { error } or { event }. */
function saveEvent(db, perm, user, input, now = Date.now()) {
  const c = cleanInput(db, input, now);
  if (c.error) return c;
  const placeCheck = () => {
    if (c.channelId && !user.isAdmin && !isMember(db, user.id, c.channelId)) return { error: 'You are not in that channel' };
    if (!canCreateIn(perm, user, c.channelId)) return { error: c.channelId ? 'You cannot create events in that channel' : 'You cannot create events somewhere else' };
    return null;
  };
  const tz = userZone(db, user.id) || c.tz;
  if (input.id == null) {
    const bad = placeCheck();
    if (bad) return bad;
    if (c.startAt < now - 5 * MIN) return { error: 'The start time has already passed' };
    const id = db.prepare(`INSERT INTO bazaar_events (name, description, channel_id, location, start_at, end_at, series_start, repeat, tz, image, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.name, c.description, c.channelId, c.location, c.startAt, c.endAt, c.startAt, c.repeat, tz, c.image, user.id, now).lastInsertRowid;
    db.prepare('INSERT OR IGNORE INTO bazaar_event_interest (event_id, user_id) VALUES (?, ?)').run(id, user.id); // like Discord: the creator is interested
    changed();
    return { event: getEvent(db, id) };
  }
  const ev = getEvent(db, input.id);
  if (!ev || !canSee(db, user, ev) || !['scheduled', 'active'].includes(ev.status)) return { error: 'That event is gone' };
  if (!canManage(perm, user, ev)) return { error: 'You cannot edit this event' };
  if (c.channelId !== ev.channel_id) { const bad = placeCheck(); if (bad) return bad; } // moving it somewhere new
  const moved = c.startAt !== ev.start_at;
  if (moved && ev.status === 'active') return { error: 'A live event cannot be moved; end it first' };
  if (moved && c.startAt < now - 5 * MIN) return { error: 'The start time has already passed' };
  db.prepare(`UPDATE bazaar_events SET name = ?, description = ?, channel_id = ?, location = ?, start_at = ?, end_at = ?, series_start = ?, repeat = ?, image = ?
    WHERE id = ?`).run(c.name, c.description, c.channelId, c.location, c.startAt, c.endAt, moved || c.repeat !== ev.repeat ? c.startAt : ev.series_start, c.repeat, c.image, ev.id);
  changed();
  return { event: getEvent(db, ev.id) };
}

function setInterest(db, user, id, on) {
  const ev = getEvent(db, id);
  if (!ev || !canSee(db, user, ev) || !['scheduled', 'active'].includes(ev.status)) return { error: 'That event is gone' };
  if (user.isGuest) return { error: 'Guests cannot mark events' };
  if (on) db.prepare('INSERT OR IGNORE INTO bazaar_event_interest (event_id, user_id) VALUES (?, ?)').run(ev.id, user.id);
  else db.prepare('DELETE FROM bazaar_event_interest WHERE event_id = ? AND user_id = ?').run(ev.id, user.id);
  changed();
  return { ok: true };
}

// Moves a repeating event to its next date, or closes a one-off.
function finish(db, ev, status, now) {
  lastVoice.delete(ev.id);
  const next = ev.repeat === 'none' ? null : time.occurrenceAfter(ev.series_start, ev.repeat, ev.tz, Math.max(now, ev.start_at));
  if (next) {
    const end = ev.end_at ? next + (ev.end_at - ev.start_at) : null;
    db.prepare("UPDATE bazaar_events SET status = 'scheduled', start_at = ?, end_at = ?, started_at = NULL WHERE id = ?").run(next, end, ev.id);
  } else {
    db.prepare('UPDATE bazaar_events SET status = ? WHERE id = ?').run(status, ev.id);
  }
}

/** Start, end, skip (a repeating event's next date) or cancel. */
function act(db, perm, user, id, action, now = Date.now()) {
  const ev = getEvent(db, id);
  if (!ev || !canSee(db, user, ev) || !['scheduled', 'active'].includes(ev.status)) return { error: 'That event is gone' };
  if (!canManage(perm, user, ev)) return { error: 'You cannot change this event' };
  if (action === 'start') {
    if (ev.status !== 'scheduled') return { error: 'It has already started' };
    startEvent(db, ev, user.id, now);
  } else if (action === 'end') {
    if (ev.status !== 'active') return { error: 'It has not started' };
    finish(db, ev, 'completed', now);
  } else if (action === 'skip') {
    if (ev.status !== 'scheduled' || ev.repeat === 'none') return { error: 'Only a repeating event that has not started can skip a date' };
    finish(db, ev, 'canceled', now);
  } else if (action === 'cancel') {
    lastVoice.delete(ev.id);
    db.prepare("UPDATE bazaar_events SET status = 'canceled' WHERE id = ?").run(ev.id);
  } else return { error: 'Unknown action' };
  changed();
  return { ok: true };
}

function startEvent(db, ev, startedBy, now) {
  db.prepare("UPDATE bazaar_events SET status = 'active', started_at = ? WHERE id = ?").run(now, ev.id);
  lastVoice.set(ev.id, now);
  notifyStarted(db, getEvent(db, ev.id), startedBy);
}

// Everyone Interested who can see the event: a pop-up on every device they
// have open, and a push notification on the ones that are away.
function notifyStarted(db, ev, startedBy) {
  if (!h) return;
  const ids = db.prepare('SELECT user_id FROM bazaar_event_interest WHERE event_id = ?').all(ev.id).map((r) => r.user_id);
  if (!ids.length) return;
  const ch = channelOf(db, ev.channel_id);
  const payload = { id: ev.id, name: ev.name, location: ev.location || null, channel: ch ? { code: ch.code, name: ch.name, voice: !!ch.voice_enabled } : null };
  const want = new Set(ids);
  for (const [, s] of h.io.sockets.sockets) {
    if (s.user && want.has(s.user.id) && canSee(db, s.user, ev)) s.emit('bazaar-event-started', payload);
  }
  if (ch && h.sendPushNotifications) {
    // Being Interested asked for this, so it counts as a ping for devices
    // set to mentions only. Only channel members are pushed.
    const names = db.prepare(`SELECT username FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((u) => `@${u.username}`).join(' ');
    try {
      h.sendPushNotifications(ch.id, ch.code, ch.name, startedBy || 0, `📅 ${ev.name}`, 'Starting now', { onlyUserIds: ids, pingText: names });
    } catch (err) { console.warn('[events] push failed:', err.message); }
  }
}

// ── The clock ───────────────────────────────────────────────────────────
function voiceCount(code) {
  const room = h && h.state && h.state.voiceUsers && h.state.voiceUsers.get(code);
  return room ? room.size : 0;
}

function sweep(now = Date.now()) {
  if (!h) return;
  const db = h.db;
  let any = false;
  for (const ev of db.prepare("SELECT * FROM bazaar_events WHERE status IN ('scheduled', 'active')").all()) {
    if (ev.status === 'scheduled') {
      // One that also ended meanwhile (Haven was down) gets no "starting now".
      if (!ev.channel_id && ev.end_at && now >= ev.end_at) { finish(db, ev, 'completed', now); any = true; }
      else if (!ev.channel_id && now >= ev.start_at) { startEvent(db, ev, 0, now); any = true; }
      else if (ev.channel_id && now >= ev.start_at + MISSED_AFTER_MS) { finish(db, ev, 'canceled', now); any = true; }
      continue;
    }
    if (ev.end_at) {
      if (now >= ev.end_at) { finish(db, ev, 'completed', now); any = true; }
      continue;
    }
    const ch = channelOf(db, ev.channel_id);
    if (ch && voiceCount(ch.code) > 0) lastVoice.set(ev.id, now);
    const quietSince = Math.max(lastVoice.get(ev.id) || 0, ev.started_at || 0);
    if (now - quietSince >= IDLE_END_MS || now - (ev.started_at || now) >= MAX_LIVE_MS) { finish(db, ev, 'completed', now); any = true; }
  }
  if (any) changed();
}

function changed() {
  if (h && h.io) h.io.emit('bazaar-events-changed');
}

// ── Discord ─────────────────────────────────────────────────────────────
// People who were Interested in a copied Discord event become Interested here
// once they link their Discord account (src/bazaarRoleBot.js).
function claimDiscordInterest(db, userId, discordId) {
  const rows = db.prepare('SELECT event_id FROM bazaar_event_discord_interest WHERE discord_id = ?').all(String(discordId));
  let n = 0;
  for (const { event_id: eventId } of rows) {
    const ev = getEvent(db, eventId);
    if (!ev) continue;
    const user = db.prepare('SELECT id, is_admin, is_guest FROM users WHERE id = ?').get(userId);
    if (!user || !canSee(db, { id: user.id, isAdmin: !!user.is_admin, isGuest: !!user.is_guest }, ev)) continue;
    n += db.prepare('INSERT OR IGNORE INTO bazaar_event_interest (event_id, user_id) VALUES (?, ?)').run(eventId, userId).changes;
  }
  if (n) changed();
  return n;
}

module.exports = {
  migrateBazaarEvents, attach, detach, sweep, canSee, canCreateIn, canManage, canCreateAnywhere, createOptions,
  serialize, listFor, interestedNames, cleanInput, saveEvent, setInterest, act, claimDiscordInterest, getEvent,
  IDLE_END_MS, MAX_LIVE_MS, MISSED_AFTER_MS,
};
