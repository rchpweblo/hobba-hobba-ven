'use strict';

// Bizarre Bazaar fork: edits and deletes cross Ferry both ways, so a message
// deleted on one side is deleted on the other, whatever deleted it, and an
// edit follows its message.
//
// Haven → Discord. Haven deletes messages from a score of places (the delete
// button, bulk deletes, moderation scrubs, self-destruct timers, deleted
// accounts, a thread's replies going with it). Rather than hook each one, a
// trigger on `messages` writes every deleted or edited message that has a
// Discord copy into `bazaar_ferry_outbox`, and Ferry drains it (src/ferry.js).
// Deleting a whole channel, or its pairing, is not a message delete: those
// rows are dropped, here when the channel goes and in Ferry when no pairing
// is left. Only edits by the Haven author cross (a row with a user), because
// a Haven copy of a Discord message is changed only by Discord's own edits.
//
// Outbound runs only while `bazaar_ferry_sync_out` is 'on'. A burst of more
// than BURST_LIMIT rows a minute sets it to 'paused' and waits for someone to
// look, because a Discord delete cannot be undone.
//
// Discord → Haven is in src/ferry.js: Discord's edit and delete events are
// matched to Haven messages through `messages.discord_message_id` (relayed
// and imported messages) and `ferry_message_map`. Those changes take their own
// rows back out of the outbox, so nothing echoes.

const SNOWFLAKE = /^\d{5,25}$/;
const BURST_LIMIT = 200;
const MODE_KEY = 'bazaar_ferry_sync_out';
const MODES = ['on', 'off', 'paused'];

function migrateBazaarFerrySync(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bazaar_ferry_outbox (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      kind               TEXT NOT NULL,
      haven_message_id   INTEGER NOT NULL,
      channel_id         INTEGER,
      thread_id          INTEGER,
      discord_message_id TEXT,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bazaar_ferry_outbox_haven ON bazaar_ferry_outbox (haven_message_id);
    CREATE INDEX IF NOT EXISTS idx_bazaar_messages_discord_id ON messages (discord_message_id) WHERE discord_message_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS bazaar_ferry_outbox_delete AFTER DELETE ON messages
      WHEN OLD.discord_message_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM ferry_message_map WHERE haven_message_id = OLD.id)
    BEGIN
      INSERT INTO bazaar_ferry_outbox (kind, haven_message_id, channel_id, thread_id, discord_message_id)
      VALUES ('delete', OLD.id, OLD.channel_id, OLD.thread_id, OLD.discord_message_id);
    END;

    CREATE TRIGGER IF NOT EXISTS bazaar_ferry_outbox_edit AFTER UPDATE OF content ON messages
      WHEN OLD.content IS NOT NEW.content AND NEW.user_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM ferry_message_map WHERE haven_message_id = NEW.id)
    BEGIN
      INSERT INTO bazaar_ferry_outbox (kind, haven_message_id, channel_id, thread_id, discord_message_id)
      VALUES ('edit', NEW.id, NEW.channel_id, NEW.thread_id, NEW.discord_message_id);
    END;

    CREATE TRIGGER IF NOT EXISTS bazaar_ferry_outbox_channel_gone AFTER DELETE ON channels
    BEGIN
      DELETE FROM bazaar_ferry_outbox WHERE channel_id = OLD.id;
    END;
  `);
}

function mode(db) {
  const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(MODE_KEY);
  return row && MODES.includes(row.value) ? row.value : 'off';
}

function setMode(db, value) {
  if (!MODES.includes(value)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  db.prepare('INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(MODE_KEY, value);
}

// Rows queued in the last minute; more than BURST_LIMIT pauses outbound.
function burst(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM bazaar_ferry_outbox WHERE created_at >= datetime('now', '-60 seconds')").get().n;
}

// The next rows to send, in the order they were queued. When a thread's
// first message is deleted its replies are queued before it, so its own row,
// which holds its Discord id, is still here while they are sent.
function nextBatch(db, limit = 20) {
  return db.prepare('SELECT * FROM bazaar_ferry_outbox ORDER BY id LIMIT ?').all(limit);
}

// Deleted thread first messages whose replies are still waiting: their whole
// Discord thread can go in one call first, and the replies then need none.
function pendingThreadRoots(db, limit = 20) {
  return db.prepare(`
    SELECT o.* FROM bazaar_ferry_outbox o
    WHERE o.kind = 'delete' AND o.thread_id IS NULL
      AND EXISTS (SELECT 1 FROM bazaar_ferry_outbox r WHERE r.thread_id = o.haven_message_id)
    ORDER BY o.id LIMIT ?
  `).all(limit);
}

function done(db, id) {
  db.prepare('DELETE FROM bazaar_ferry_outbox WHERE id = ?').run(id);
}

// A change that came from Discord is not sent back to it.
function forget(db, havenMessageIds) {
  const del = db.prepare('DELETE FROM bazaar_ferry_outbox WHERE haven_message_id = ?');
  for (const id of havenMessageIds) del.run(id);
}

// The pairings that send this Haven channel's messages to Discord: its own,
// or its parent's for a sub-channel made from a Discord thread.
function outboundLinks(db, channelId) {
  return db.prepare(`
    SELECT f.* FROM ferry_links f
    WHERE f.is_active = 1 AND f.direction IN ('both', 'to_discord')
      AND f.channel_id IN (SELECT ? UNION SELECT parent_channel_id FROM channels WHERE id = ? AND parent_channel_id IS NOT NULL)
    ORDER BY (f.channel_id = ?) DESC, f.id
  `).all(channelId, channelId, channelId);
}

// Whether Discord's changes come into this Haven channel.
function inboundAllowed(db, channelId) {
  return !!db.prepare(`
    SELECT 1 FROM ferry_links f
    WHERE f.is_active = 1 AND f.direction IN ('both', 'to_haven')
      AND f.channel_id IN (SELECT ? UNION SELECT parent_channel_id FROM channels WHERE id = ? AND parent_channel_id IS NOT NULL)
  `).get(channelId, channelId);
}

// The Discord id of a Haven message, also when it was deleted along with
// this row (its own outbox row still has it).
function discordIdOf(db, havenId) {
  const own = db.prepare('SELECT discord_message_id AS d FROM messages WHERE id = ?').get(havenId)?.d
    || db.prepare('SELECT discord_message_id AS d FROM bazaar_ferry_outbox WHERE haven_message_id = ? AND discord_message_id IS NOT NULL').get(havenId)?.d
    || db.prepare('SELECT discord_message_id AS d FROM ferry_message_map WHERE haven_message_id = ?').get(havenId)?.d;
  return SNOWFLAKE.test(String(own || '')) ? String(own) : null;
}

// The Discord threads a Haven thread's replies may sit in.
function threadsOf(db, rootId) {
  const out = [];
  const add = (id) => { if (SNOWFLAKE.test(String(id || '')) && !out.includes(String(id))) out.push(String(id)); };
  for (const r of db.prepare('SELECT discord_thread_id AS t FROM bazaar_ferry_chat_threads WHERE root_message_id = ?').all(rootId)) add(r.t);
  for (const r of db.prepare('SELECT discord_thread_id AS t FROM ferry_forum_threads WHERE topic_message_id = ?').all(rootId)) add(r.t);
  // A Discord thread started from a message has that message's id.
  add(discordIdOf(db, rootId));
  return out;
}

/**
 * Where the Discord copies of one outbox row are: each copy's message id and
 * the channels it may be in, most likely first. A delete needs the exact
 * channel, which is the thread for a message in a thread. A copy Ferry made
 * or relayed is in ferry_message_map with its channel; history copied by the
 * importer has only its id, so the channel is worked out from where the
 * Haven message sits.
 */
function discordCopies(db, row, link) {
  const copies = new Map();
  const add = (messageId, channelId) => {
    if (!SNOWFLAKE.test(String(messageId || ''))) return;
    const copy = copies.get(String(messageId)) || { messageId: String(messageId), channels: [] };
    if (SNOWFLAKE.test(String(channelId || '')) && !copy.channels.includes(String(channelId))) copy.channels.push(String(channelId));
    copies.set(String(messageId), copy);
  };
  for (const m of db.prepare('SELECT discord_message_id, discord_channel_id FROM ferry_message_map WHERE haven_message_id = ?').all(row.haven_message_id)) {
    add(m.discord_message_id, m.discord_channel_id);
  }
  add(row.discord_message_id, null);
  const ch = db.prepare('SELECT discord_channel_id, parent_channel_id, is_forum FROM channels WHERE id = ?').get(row.channel_id);
  for (const copy of copies.values()) {
    const tries = [];
    if (row.thread_id) tries.push(...threadsOf(db, row.thread_id));
    // A forum post's first message is in the post's thread, which has its id.
    if (!row.thread_id && ch && ch.is_forum) tries.push(copy.messageId);
    if (ch && ch.discord_channel_id) tries.push(ch.discord_channel_id);
    if (link && link.discord_channel_id) tries.push(link.discord_channel_id);
    // Where the channel's kind is unknown, its thread last.
    if (!row.thread_id) tries.push(copy.messageId);
    for (const t of tries) if (SNOWFLAKE.test(String(t)) && !copy.channels.includes(String(t))) copy.channels.push(String(t));
  }
  return [...copies.values()];
}

// The Discord threads that may belong to a deleted Haven message: a forum
// post, a thread made on its copy, or one started from its copy (which has
// the copy's id). Only candidates: Ferry deletes one only after Discord says
// it is a thread.
function threadsToDelete(db, row) {
  if (row.thread_id) return [];
  const out = [];
  for (const r of db.prepare('SELECT discord_thread_id AS t FROM ferry_forum_threads WHERE topic_message_id = ?').all(row.haven_message_id)) out.push(String(r.t));
  for (const r of db.prepare('SELECT discord_thread_id AS t FROM bazaar_ferry_chat_threads WHERE root_message_id = ?').all(row.haven_message_id)) out.push(String(r.t));
  if (row.discord_message_id) out.push(String(row.discord_message_id));
  for (const r of db.prepare('SELECT discord_message_id AS t FROM ferry_message_map WHERE haven_message_id = ?').all(row.haven_message_id)) out.push(String(r.t));
  return [...new Set(out)].filter(t => SNOWFLAKE.test(t));
}

// The Haven messages a Discord message is, in channels that take Discord's
// changes.
function havenCopies(db, discordMessageId) {
  if (!SNOWFLAKE.test(String(discordMessageId || ''))) return [];
  const rows = db.prepare(`
    SELECT m.id, m.channel_id, m.thread_id, m.user_id, m.content, m.is_archived, c.code AS channel_code
    FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE m.discord_message_id = ?
    UNION
    SELECT m.id, m.channel_id, m.thread_id, m.user_id, m.content, m.is_archived, c.code AS channel_code
    FROM ferry_message_map f JOIN messages m ON m.id = f.haven_message_id JOIN channels c ON c.id = m.channel_id
    WHERE f.discord_message_id = ?
  `).all(String(discordMessageId), String(discordMessageId));
  return rows.filter(r => inboundAllowed(db, r.channel_id));
}

module.exports = {
  BURST_LIMIT,
  migrateBazaarFerrySync,
  mode,
  setMode,
  burst,
  nextBatch,
  pendingThreadRoots,
  done,
  forget,
  outboundLinks,
  inboundAllowed,
  discordCopies,
  threadsToDelete,
  havenCopies,
};
