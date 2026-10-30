'use strict';

// Bizarre Bazaar fork: a banner message hangs at the top of a channel, or of
// a forum post, above the messages. One per channel and one per forum post:
// an optional title, a body (text, pictures and files, as a message), and a
// blur for NSFW. A chat thread has none. Haven only: Discord has nothing
// like it, so Ferry leaves banners alone.
//
// Who sets one: whoever manages the channel's settings (as Channel Functions),
// and for a forum post also the person who started it.
// Socket side: src/socketHandlers/bazaarBanners.js. Client side:
// public/js/modules/app-bazaar-banners.js.

const TITLE_MAX = 120;
const BODY_MAX = 4000;

function migrateBazaarBanners(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bazaar_banners (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      topic_id   INTEGER,
      scope      TEXT NOT NULL UNIQUE,
      title      TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL,
      nsfw       INTEGER NOT NULL DEFAULT 0,
      set_by     INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bazaar_banners_channel ON bazaar_banners (channel_id);
    CREATE TRIGGER IF NOT EXISTS bazaar_banners_channel_gone AFTER DELETE ON channels
    BEGIN
      DELETE FROM bazaar_banners WHERE channel_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS bazaar_banners_topic_gone AFTER DELETE ON messages
      WHEN OLD.thread_id IS NULL
    BEGIN
      DELETE FROM bazaar_banners WHERE topic_id = OLD.id;
    END;
  `);
}

const scopeKey = (channelId, topicId) => (topicId ? `t:${topicId}` : `c:${channelId}`);

// What a request names: a channel (by code) and, for a forum post, the
// post's first message. Null when there is no such place, or it cannot have
// a banner (a DM, a chat thread, a reply).
function placeOf(db, code, topicId) {
  if (typeof code !== 'string' || !code) return null;
  const ch = db.prepare('SELECT id, code, is_dm, is_forum FROM channels WHERE code = ?').get(code);
  if (!ch || ch.is_dm) return null;
  if (topicId == null) return { channel: ch, topic: null };
  if (!Number.isInteger(topicId) || !ch.is_forum) return null;
  const topic = db.prepare('SELECT id, user_id FROM messages WHERE id = ? AND channel_id = ? AND thread_id IS NULL').get(topicId, ch.id);
  return topic ? { channel: ch, topic } : null;
}

function get(db, place) {
  const row = db.prepare(`
    SELECT b.title, b.body, b.nsfw, b.updated_at, COALESCE(u.display_name, u.username) AS set_by
    FROM bazaar_banners b LEFT JOIN users u ON u.id = b.set_by WHERE b.scope = ?
  `).get(scopeKey(place.channel.id, place.topic && place.topic.id));
  return row ? { title: row.title, body: row.body, nsfw: !!row.nsfw, updatedAt: row.updated_at, setBy: row.set_by || null } : null;
}

// Returns { error } or { banner }.
function save(db, place, userId, data, clean) {
  const title = clean(String((data && data.title) || '')).trim().slice(0, TITLE_MAX);
  const body = clean(String((data && data.body) || '')).trim();
  if (!body) return { error: 'A banner needs a message' };
  if (body.length > BODY_MAX) return { error: `A banner can be at most ${BODY_MAX} characters` };
  db.prepare(`
    INSERT INTO bazaar_banners (channel_id, topic_id, scope, title, body, nsfw, set_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scope) DO UPDATE SET title = excluded.title, body = excluded.body, nsfw = excluded.nsfw,
      set_by = excluded.set_by, updated_at = CURRENT_TIMESTAMP
  `).run(place.channel.id, place.topic ? place.topic.id : null, scopeKey(place.channel.id, place.topic && place.topic.id), title, body, data && data.nsfw ? 1 : 0, userId);
  return { banner: get(db, place) };
}

function remove(db, place) {
  return db.prepare('DELETE FROM bazaar_banners WHERE scope = ?').run(scopeKey(place.channel.id, place.topic && place.topic.id)).changes > 0;
}

module.exports = { TITLE_MAX, BODY_MAX, migrateBazaarBanners, placeOf, get, save, remove };
