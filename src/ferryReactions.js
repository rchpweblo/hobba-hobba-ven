'use strict';

// Reactions across the Ferry bridge.
//
// Discord to Haven: a reaction on a bridged Discord message shows on its
// Haven copy, under the Discord person's name. Discord people have no Haven
// account, so their reactions are kept here rather than in `reactions`, and
// are added to the list every time a message's reactions are sent.
//
// Haven to Discord: Discord lets the bot react only as itself, once per
// emoji. So the bot puts an emoji on the Discord message while someone on
// Haven who may use Ferry has reacted with it, and takes it off when the last
// of them takes theirs back. Discord shows a count of one for it, whoever and
// however many reacted on Haven.
//
// Which Discord message a Haven message is comes from ferry_message_map
// (src/ferryReplies.js), so only messages Ferry carried take part.
// Bizarre Bazaar fork: copied history, sub-channels and thread replies take
// part too (src/bazaarFerryReactions.js).

const { IN_JSON, jsonList } = require('./bazaarSqlList'); // Bizarre Bazaar fork
const bazaarFerryReactions = require('./bazaarFerryReactions'); // Bizarre Bazaar fork

const SNOWFLAKE = /^\d{5,25}$/;
const NAMED = /^:([a-zA-Z0-9_-]{1,30}):$/;
const MAX_NAME = 80;
const MARK = ' (Discord)';

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ferry_reactions (
      message_id      INTEGER NOT NULL,
      emoji           TEXT    NOT NULL,
      discord_user_id TEXT    NOT NULL,
      name            TEXT    NOT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, emoji, discord_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ferry_reactions_message ON ferry_reactions (message_id);
  `);
  // Reactions on messages deleted since the last start go with them.
  db.prepare('DELETE FROM ferry_reactions WHERE message_id NOT IN (SELECT id FROM messages)').run();
}

// ── Reading ───────────────────────────────────────────────────

function discordRows(db, messageIds) {
  if (!messageIds.length) return [];
  // Bizarre Bazaar fork: one JSON parameter, so a whole long topic fits. A
  // Discord person linked to a Haven account (src/bazaarRoleBot.js) shows by
  // their Haven name.
  return db.prepare(`SELECT r.message_id, r.emoji, r.discord_user_id,
      COALESCE((SELECT COALESCE(NULLIF(u.display_name, ''), u.username) FROM bazaar_discord_links l
                JOIN users u ON u.id = l.user_id WHERE l.discord_id = r.discord_user_id AND l.source != 'none'), r.name) AS name
    FROM ferry_reactions r
    WHERE r.message_id ${IN_JSON} ORDER BY r.created_at, r.rowid`).all(jsonList(messageIds));
}

const asEntry = (r) => ({ emoji: r.emoji, user_id: `discord:${r.discord_user_id}`, username: r.name + MARK });

/** Adds the Discord reactions to a map of message id -> reaction list. */
function mergeInto(db, messageIds, reactionMap) {
  try {
    for (const r of discordRows(db, messageIds)) {
      if (!reactionMap.has(r.message_id)) reactionMap.set(r.message_id, []);
      reactionMap.get(r.message_id).push(asEntry(r));
    }
  } catch (err) {
    // Haven's own reactions still show; only the Discord ones are missing.
    console.warn('[ferry] could not read Discord reactions:', err.message);
  }
  return reactionMap;
}

/** Every reaction on one message, Haven's and Discord's, as clients get them. */
function listFor(db, messageId) {
  const list = db.prepare(`
    SELECT r.emoji, r.user_id, COALESCE(u.display_name, u.username) as username FROM reactions r
    JOIN users u ON r.user_id = u.id WHERE r.message_id = ? ORDER BY r.id
  `).all(messageId);
  return mergeInto(db, [messageId], new Map([[messageId, list]])).get(messageId);
}

// ── Discord to Haven ──────────────────────────────────────────

// The Haven copies of a Discord message, in channels whose pairing carries
// Discord into Haven.
function havenCopies(db, discordMessageId) {
  // Bizarre Bazaar fork: copied history, sub-channels and threads too (src/bazaarFerryReactions.js).
  return bazaarFerryReactions.havenCopies(db, discordMessageId);
}

// A Discord emoji as Haven writes it: Unicode as is, a custom one as :name:
// when this server has a custom emoji by that name, otherwise null.
function havenEmojiFor(db, emoji, isUsableEmoji) {
  if (!emoji) return null;
  if (!emoji.id) return emoji.name && isUsableEmoji(db, emoji.name) ? emoji.name : null;
  const named = `:${String(emoji.name || '')}:`;
  return NAMED.test(named) && isUsableEmoji(db, named) ? named : null;
}

function reactorName(d) {
  const m = d.member || {};
  const u = m.user || {};
  const name = String(m.nick || u.global_name || u.username || 'Discord user').replace(/[\r\n]+/g, ' ').trim();
  return name.slice(0, MAX_NAME) || 'Discord user';
}

/**
 * Applies one gateway reaction event. kind is 'add', 'remove', 'remove_all'
 * or 'remove_emoji'. Returns the Haven messages that changed, each with its
 * new reaction list, for the caller to send to the channel.
 */
function fromDiscord(db, kind, d, { botId = null, isUsableEmoji }) {
  if (!d || !SNOWFLAKE.test(String(d.message_id || ''))) return [];
  if ((kind === 'add' || kind === 'remove') && (!SNOWFLAKE.test(String(d.user_id || '')) || d.user_id === botId)) return [];
  const copies = havenCopies(db, String(d.message_id));
  if (!copies.length) return [];
  const emoji = kind === 'remove_all' ? null : havenEmojiFor(db, d.emoji, isUsableEmoji);
  if (kind !== 'remove_all' && !emoji) return [];

  const changed = [];
  for (const m of copies) {
    let n = 0;
    if (kind === 'add') {
      n = db.prepare('INSERT OR IGNORE INTO ferry_reactions (message_id, emoji, discord_user_id, name) VALUES (?, ?, ?, ?)')
        .run(m.id, emoji, String(d.user_id), reactorName(d)).changes;
    } else if (kind === 'remove') {
      n = db.prepare('DELETE FROM ferry_reactions WHERE message_id = ? AND emoji = ? AND discord_user_id = ?')
        .run(m.id, emoji, String(d.user_id)).changes;
    } else if (kind === 'remove_emoji') {
      n = db.prepare('DELETE FROM ferry_reactions WHERE message_id = ? AND emoji = ?').run(m.id, emoji).changes;
    } else {
      n = db.prepare('DELETE FROM ferry_reactions WHERE message_id = ?').run(m.id).changes;
    }
    if (n) changed.push({ messageId: m.id, channelCode: m.code, reactions: listFor(db, m.id) });
  }
  return changed;
}

// ── Haven to Discord ──────────────────────────────────────────

// A Haven emoji as Discord's reaction API takes it, or null when the Discord
// server has nothing to match it: Unicode as is, :name: as the guild's own
// emote of that name.
function discordEmojiFor(emoji, guildEmojis) {
  const m = NAMED.exec(String(emoji || ''));
  if (!m) return encodeURIComponent(emoji);
  const e = guildEmojis && guildEmojis.get(m[1].toLowerCase());
  return e ? encodeURIComponent(`${e.name}:${e.id}`) : null;
}

// The Discord messages a Haven message went out as (or came from), in
// pairings that carry Haven out to Discord.
function discordCopies(db, havenMessageId) {
  // Bizarre Bazaar fork: copied history, sub-channels and threads too (src/bazaarFerryReactions.js).
  return bazaarFerryReactions.discordCopies(db, havenMessageId);
}

/**
 * Whether the bot's reaction for this emoji should be on the Discord copy:
 * someone on Haven who may use Ferry in this channel has reacted with it.
 */
function botShouldReact(db, havenMessageId, emoji, mayUseFerry) {
  const reactors = db.prepare('SELECT user_id FROM reactions WHERE message_id = ? AND emoji = ?').all(havenMessageId, emoji);
  return reactors.some(r => mayUseFerry(r.user_id));
}

module.exports = {
  ensureSchema, mergeInto, listFor, fromDiscord, havenEmojiFor, reactorName,
  discordEmojiFor, discordCopies, botShouldReact,
};
