'use strict';
/**
 * Bizarre Bazaar fork: Discord @mentions that reach the Haven people they name.
 *
 * A message Ferry brings from Discord keeps Discord's own code for each person
 * it mentions, <@id>, the way copied history does. The client shows the code
 * as a name (src/bazaarDiscordRefs.js): the Haven name of someone who linked
 * Discord for the Role Bot (bazaar_discord_links), otherwise the Discord name
 * saved here. So a mention reads right as soon as its person links, old
 * messages included.
 *
 * A linked person mentioned in a new message is pinged: the client treats the
 * code as a mention of them (sound, highlight, the mentions bell), and their
 * devices are pushed here, as for an @mention typed in Haven. A message sent
 * on Discord with @silent pushes nobody. Messages copied by the importer never
 * come through here, so old messages ping nobody.
 *
 * Upstream Ferry turned each code into the person's Discord name as plain
 * text, which pinged nobody, or the wrong Haven member when one shared it.
 */

const refs = require('./bazaarDiscordRefs');

const SNOWFLAKE = /^\d{15,25}$/;
const SUPPRESS_NOTIFICATIONS = 1 << 12; // Discord's @silent

function mentionedIds(msg) {
  const out = [];
  for (const u of (msg && Array.isArray(msg.mentions) ? msg.mentions : [])) {
    if (u && SNOWFLAKE.test(String(u.id))) out.push(String(u.id));
  }
  return [...new Set(out)];
}

// The name Discord shows for a mentioned person in that server.
function discordName(u) {
  return (u && ((u.member && u.member.nick) || u.global_name || u.username)) || '';
}

/**
 * The text with each person code kept as <@id> (Discord's older <@!id> made
 * the same), and the names of the people it mentions saved for the client.
 */
function keepPersonCodes(db, text, msg) {
  const out = String(text || '').replace(/<@!(\d{15,25})>/g, '<@$1>');
  if (!db) return out;
  for (const u of (msg && Array.isArray(msg.mentions) ? msg.mentions : [])) {
    const name = discordName(u);
    if (!u || !SNOWFLAKE.test(String(u.id)) || !name) continue;
    try {
      const had = db.prepare("SELECT name FROM bazaar_discord_names WHERE kind = 'user' AND discord_id = ?").get(String(u.id));
      if (!had || had.name !== name.trim().slice(0, 100)) refs.saveName(db, 'user', String(u.id), name);
    } catch (err) {
      // The mention still shows, by whatever name was saved before.
      console.warn('[ferry] could not save a Discord name:', err.message);
    }
  }
  return out;
}

// Haven people linked to these Discord ids: [{ id, username, discordId }].
function linkedUsers(db, discordIds) {
  if (!db || !discordIds.length) return [];
  try {
    return db.prepare(`
      SELECT u.id, u.username, l.discord_id AS discordId
      FROM bazaar_discord_links l JOIN users u ON u.id = l.user_id
      WHERE l.source != 'none' AND l.discord_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(discordIds));
  } catch (err) {
    // No pings rather than no message.
    console.warn('[ferry] could not look up linked Discord accounts:', err.message);
    return [];
  }
}

// Person codes as @names, for a notification's text.
function readableText(db, text) {
  const names = new Map();
  const ids = [...new Set([...String(text || '').matchAll(/<@!?(\d{15,25})>/g)].map(m => m[1]))];
  if (db && ids.length) {
    try {
      for (const r of db.prepare("SELECT discord_id, name FROM bazaar_discord_names WHERE kind = 'user' AND discord_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids))) names.set(r.discord_id, r.name);
      for (const r of db.prepare(`SELECT l.discord_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name
        FROM bazaar_discord_links l JOIN users u ON u.id = l.user_id
        WHERE l.source != 'none' AND l.discord_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids))) names.set(r.discord_id, r.name);
    } catch { /* the codes stay as they are */ }
  }
  return String(text || '').replace(/<@!?(\d{15,25})>/g, (full, id) => (names.has(id) ? '@' + names.get(id) : full));
}

/**
 * Pushes the linked people a relayed message mentions, once per Haven copy.
 * `targets` are the copies ({ havenMessageId, channelCode }); `push` is
 * sendPushNotifications. The author of a Haven message being replied to is
 * left out: the reply already pushed them.
 */
function notify(db, push, msg, content, targets) {
  if (!db || typeof push !== 'function' || !msg || !Array.isArray(targets) || !targets.length) return [];
  if ((Number(msg.flags) || 0) & SUPPRESS_NOTIFICATIONS) return [];
  const people = linkedUsers(db, mentionedIds(msg));
  if (!people.length) return [];
  const sender = discordName(msg.author) || 'Discord user';
  const text = readableText(db, content);
  const sent = [];
  const row = db.prepare(`
    SELECT m.channel_id, c.name AS channel_name, r.user_id AS reply_user
    FROM messages m JOIN channels c ON c.id = m.channel_id
    LEFT JOIN messages r ON r.id = m.reply_to
    WHERE m.id = ?
  `);
  for (const t of targets) {
    const m = row.get(t.havenMessageId);
    if (!m) continue;
    const who = people.filter(p => p.id !== m.reply_user);
    if (!who.length) continue;
    try {
      push(m.channel_id, t.channelCode, m.channel_name || '', 0, sender, text, {
        onlyUserIds: who.map(p => p.id),
        // What a device set to mentions only is matched against.
        pingText: who.map(p => '@' + p.username).join(' '),
      });
      sent.push({ havenMessageId: t.havenMessageId, userIds: who.map(p => p.id) });
    } catch (err) {
      console.warn('[ferry] could not push a Discord mention:', err.message);
    }
  }
  return sent;
}

module.exports = { keepPersonCodes, linkedUsers, readableText, notify, mentionedIds };
