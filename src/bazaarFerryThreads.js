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

module.exports = { inboundChannel, outboundTarget };
