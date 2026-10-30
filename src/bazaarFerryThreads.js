'use strict';

// Bizarre Bazaar fork: Ferry and the Discord threads that are Haven channels
// of their own.
//
// A Discord thread can be imported into a sub-channel made for it (its id in
// channels.discord_channel_id, see src/routes/import.js). Ferry pairs
// channels, not threads, so without this a new message in such a thread
// became a Haven thread in the parent channel, and nothing written in the
// sub-channel reached Discord. While the sub-channel's Haven parent is paired
// with Discord, the thread's messages come into the sub-channel, and messages
// written there go into the thread, through the parent pairing's webhook.

const SNOWFLAKE = /^\d{15,25}$/;
const FORUM_TYPES = [15, 16];

// The Haven channel a Discord thread's messages come into, or null. Only a
// sub-channel with no pairing of its own whose parent brings messages in.
function inboundChannel(db, discordThreadId) {
  if (!SNOWFLAKE.test(String(discordThreadId || ''))) return null;
  return db.prepare(`
    SELECT c.id, c.code FROM channels c
    WHERE c.discord_channel_id = ? AND c.parent_channel_id IS NOT NULL AND c.is_dm = 0
      AND NOT EXISTS (SELECT 1 FROM ferry_links f WHERE f.channel_id = c.id)
      AND EXISTS (SELECT 1 FROM ferry_links f WHERE f.channel_id = c.parent_channel_id
                  AND f.is_active = 1 AND f.direction IN ('both', 'to_haven'))
    LIMIT 1
  `).get(String(discordThreadId)) || null;
}

// Where a message written in a sub-channel goes on Discord: the thread, and
// the parent's pairings that send to Discord (chat pairings only; a forum's
// posts are threads already). Null when the channel is no such sub-channel.
function outboundTarget(db, channelId) {
  const ch = db.prepare('SELECT discord_channel_id, parent_channel_id FROM channels WHERE id = ? AND is_dm = 0').get(channelId);
  if (!ch || !ch.parent_channel_id || !SNOWFLAKE.test(String(ch.discord_channel_id || ''))) return null;
  if (db.prepare('SELECT 1 FROM ferry_links WHERE channel_id = ? LIMIT 1').get(channelId)) return null;
  const links = db.prepare(`
    SELECT id, channel_id, guild_id, guild_name, discord_channel_id, discord_channel_name,
           direction, out_mode, webhook_id, webhook_token, discord_channel_type
    FROM ferry_links
    WHERE channel_id = ? AND is_active = 1 AND direction IN ('both', 'to_discord')
  `).all(ch.parent_channel_id).filter(l => !FORUM_TYPES.includes(l.discord_channel_type));
  return links.length ? { threadId: String(ch.discord_channel_id), links } : null;
}

// ── Threads in paired chat channels ──
// A Haven thread hangs from a top-level message; on Discord the same thread
// is a thread on the Discord copy of that message. Which Discord thread a
// Haven thread is, once known, is kept here, so replies written in Haven go
// into it and replies written on Discord come back under the same message.

function migrateBazaarFerryThreads(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bazaar_ferry_chat_threads (
      root_message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      discord_thread_id TEXT    NOT NULL,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (root_message_id, discord_thread_id)
    );
    CREATE INDEX IF NOT EXISTS idx_bazaar_ferry_chat_threads_thread ON bazaar_ferry_chat_threads (discord_thread_id);
  `);
}

function rememberThread(db, rootMessageId, channelId, discordThreadId) {
  if (!SNOWFLAKE.test(String(discordThreadId || ''))) return;
  db.prepare('INSERT OR IGNORE INTO bazaar_ferry_chat_threads (root_message_id, channel_id, discord_thread_id) VALUES (?, ?, ?)')
    .run(rootMessageId, channelId, String(discordThreadId));
}

function forgetThread(db, discordThreadId) {
  db.prepare('DELETE FROM bazaar_ferry_chat_threads WHERE discord_thread_id = ?').run(String(discordThreadId));
}

function threadOfRoot(db, rootMessageId) {
  return db.prepare('SELECT discord_thread_id AS id FROM bazaar_ferry_chat_threads WHERE root_message_id = ? LIMIT 1').get(rootMessageId)?.id || null;
}

// The Haven message a Discord thread hangs from in one channel, when the
// thread was started from Haven or joined to one before.
function rootOfThread(db, channelId, discordThreadId) {
  return db.prepare(`
    SELECT t.root_message_id AS id FROM bazaar_ferry_chat_threads t JOIN messages m ON m.id = t.root_message_id
    WHERE t.channel_id = ? AND t.discord_thread_id = ? AND m.thread_id IS NULL LIMIT 1
  `).get(channelId, String(discordThreadId))?.id || null;
}

module.exports = { inboundChannel, outboundTarget, migrateBazaarFerryThreads, rememberThread, forgetThread, threadOfRoot, rootOfThread };
