'use strict';

// Bizarre Bazaar fork: which Haven message is which Discord message, for
// reactions (src/ferryReactions.js).
//
// Upstream matches only messages Ferry carried itself (ferry_message_map), in
// Haven channels with a pairing of their own. Here a reaction also crosses on:
//  - copied history and anything else with messages.discord_message_id, both
//    ways, so a reaction on a years-old message reaches the other side;
//  - sub-channels made for a Discord thread (src/bazaarFerryThreads.js),
//    through their parent's pairing, as their messages do;
//  - replies in threads and forum topics. Their Discord channel is the thread:
//    the one mapped for it, otherwise the Discord id of the thread's first
//    message, since a Discord thread has the id of the message it started
//    from (and a forum post the id of its first message).

const SNOWFLAKE = /^\d{5,25}$/;
const DIRECTIONS = { in: ['both', 'to_haven'], out: ['both', 'to_discord'] };

// The active pairings that carry a Haven channel's messages the given way:
// its own, or for a sub-channel without one, its parent's.
function pairingsFor(db, channelId, way) {
  const dirs = DIRECTIONS[way];
  return db.prepare(`
    SELECT l.guild_id, l.discord_channel_id, (l.channel_id = c.id) AS own
    FROM channels c JOIN ferry_links l ON l.is_active = 1 AND l.direction IN (?, ?)
      AND (l.channel_id = c.id
           OR (l.channel_id = c.parent_channel_id AND c.discord_channel_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM ferry_links o WHERE o.channel_id = c.id)))
    WHERE c.id = ? AND c.is_dm = 0
  `).all(dirs[0], dirs[1], channelId);
}

// SQL true when channel alias `c` has such a pairing (one ? for nothing).
function pairedSql(way) {
  const [a, b] = DIRECTIONS[way];
  return `EXISTS (SELECT 1 FROM ferry_links l WHERE l.is_active = 1 AND l.direction IN ('${a}', '${b}')
    AND (l.channel_id = c.id
         OR (l.channel_id = c.parent_channel_id AND c.discord_channel_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ferry_links o WHERE o.channel_id = c.id))))`;
}

/** The Haven copies of a Discord message, where Discord comes into Haven. */
function havenCopies(db, discordMessageId) {
  return db.prepare(`
    SELECT DISTINCT m.id, m.channel_id, c.code FROM messages m
    JOIN channels c ON c.id = m.channel_id
    WHERE m.id IN (SELECT haven_message_id FROM ferry_message_map WHERE discord_message_id = ?
                   UNION SELECT id FROM messages WHERE discord_message_id = ?)
      AND ${pairedSql('in')}
  `).all(String(discordMessageId), String(discordMessageId));
}

// The Discord thread a Haven thread or forum topic is, by its first message.
function discordThreadOf(db, root) {
  if (!root) return null;
  const mapped = db.prepare('SELECT discord_thread_id AS id FROM bazaar_ferry_chat_threads WHERE root_message_id = ? LIMIT 1').get(root.id)
    || db.prepare('SELECT discord_thread_id AS id FROM ferry_forum_threads WHERE topic_message_id = ? LIMIT 1').get(root.id);
  if (mapped && SNOWFLAKE.test(String(mapped.id))) return String(mapped.id);
  return SNOWFLAKE.test(String(root.discord_message_id || '')) ? String(root.discord_message_id) : null;
}

// The Discord channel (or thread) a Haven message with a Discord id lives in.
function discordChannelOf(db, m) {
  if (m.thread_id) {
    const root = db.prepare('SELECT id, discord_message_id FROM messages WHERE id = ?').get(m.thread_id);
    return discordThreadOf(db, root);
  }
  if (m.is_forum) return discordThreadOf(db, m); // a topic's first message is in its post
  return SNOWFLAKE.test(String(m.discord_channel_id || '')) ? String(m.discord_channel_id) : null;
}

/**
 * The Discord messages a Haven message is (it went out as one, came from one,
 * or was copied from one), where Haven goes out to Discord:
 * [{ discord_message_id, discord_channel_id, guild_id }].
 */
function discordCopies(db, havenMessageId) {
  const m = db.prepare(`
    SELECT m.id, m.channel_id, m.thread_id, m.discord_message_id, c.is_forum, c.discord_channel_id
    FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?
  `).get(havenMessageId);
  if (!m) return [];
  const links = pairingsFor(db, m.channel_id, 'out');
  if (!links.length) return [];
  const guildId = links[0].guild_id;
  const out = new Map();
  for (const f of db.prepare('SELECT discord_message_id, discord_channel_id FROM ferry_message_map WHERE haven_message_id = ?').all(m.id)) {
    out.set(String(f.discord_message_id), { discord_message_id: String(f.discord_message_id), discord_channel_id: String(f.discord_channel_id), guild_id: guildId });
  }
  if (SNOWFLAKE.test(String(m.discord_message_id || '')) && !out.has(String(m.discord_message_id))) {
    const own = links.find(l => l.own);
    const where = discordChannelOf(db, { ...m, discord_channel_id: m.discord_channel_id || (own && own.discord_channel_id) });
    if (where) out.set(String(m.discord_message_id), { discord_message_id: String(m.discord_message_id), discord_channel_id: where, guild_id: guildId });
  }
  return [...out.values()];
}

/** Whether Haven reactions in this channel go to Discord at all. */
function sendsOut(db, channelId) {
  try { return pairingsFor(db, channelId, 'out').length > 0; } catch { return false; }
}

module.exports = { havenCopies, discordCopies, discordChannelOf, discordThreadOf, sendsOut, pairingsFor };
