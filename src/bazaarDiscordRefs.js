'use strict';
/**
 * Bizarre Bazaar fork: Discord mentions in copied history.
 *
 * Messages copied from Discord keep Discord's own codes: <@id> for a person,
 * <@&id> for a role and <#id> for a channel. The text is left as it is; the
 * client turns the codes into names when it draws a message
 * (public/js/modules/app-bazaar-discord-refs.js), from the table built here:
 *
 *   - a person who linked Discord for the Role Bot shows as their Haven name,
 *     so names get better by themselves as people link;
 *   - a role in the Role Bot's rules shows as its Haven role, colour and all;
 *   - a channel copied into Haven shows as a link to it, for people who can
 *     see it;
 *   - anything else shows by the name Discord gave it, kept in
 *     bazaar_discord_names by tools/bazaar-discord-names.js.
 *
 * Nobody is pinged: this only changes how old messages read.
 */

const KINDS = new Set(['user', 'role', 'channel']);
const SNOWFLAKE = /^\d{15,25}$/;

function migrateBazaarDiscordRefs(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bazaar_discord_names (
      kind TEXT NOT NULL,
      discord_id TEXT NOT NULL,
      name TEXT NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (kind, discord_id)
    )
  `);
}

function saveName(db, kind, discordId, name) {
  if (!KINDS.has(kind) || !SNOWFLAKE.test(String(discordId)) || typeof name !== 'string' || !name.trim()) return false;
  db.prepare(`INSERT INTO bazaar_discord_names (kind, discord_id, name, fetched_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(kind, discord_id) DO UPDATE SET name = excluded.name, fetched_at = excluded.fetched_at`)
    .run(kind, String(discordId), name.trim().slice(0, 100));
  return true;
}

// The ids in a text, by kind.
function idsIn(text) {
  const out = { user: new Set(), role: new Set(), channel: new Set() };
  for (const m of String(text || '').matchAll(/<(@!?|@&|#)(\d{15,25})>/g)) {
    out[m[1] === '@&' ? 'role' : m[1] === '#' ? 'channel' : 'user'].add(m[2]);
  }
  return out;
}

function roleMapOf(db) {
  try {
    const row = db.prepare("SELECT value FROM server_settings WHERE key = 'bazaar_role_bot_rules'").get();
    const rules = JSON.parse((row && row.value) || 'null');
    return rules && rules.roleMap && typeof rules.roleMap === 'object' ? rules.roleMap : {};
  } catch { return {}; } // broken rules: roles fall back to their Discord names
}

/**
 * What the client needs to read the codes:
 *   users:    { discordId: { name, userId? } }
 *   roles:    { discordId: { name, roleId?, color?, color2?, color_shimmer? } }
 *   channels: { discordId: { channelId } | { name } }
 * A copied channel goes out as its Haven id only, never its name or code: the
 * client names it from its own channel list, so a channel someone cannot see
 * stays hidden from them.
 */
function refsFor(db) {
  const users = {}, roles = {}, channels = {};
  for (const r of db.prepare('SELECT kind, discord_id, name FROM bazaar_discord_names').all()) {
    const into = r.kind === 'user' ? users : r.kind === 'role' ? roles : r.kind === 'channel' ? channels : null;
    if (into) into[r.discord_id] = { name: r.name };
  }
  for (const l of db.prepare(`SELECT l.discord_id, l.user_id, COALESCE(NULLIF(u.display_name, ''), u.username) AS name
      FROM bazaar_discord_links l JOIN users u ON u.id = l.user_id WHERE l.source != 'none'`).all()) {
    users[l.discord_id] = { name: l.name, userId: l.user_id };
  }
  const roleRow = db.prepare('SELECT id, name, color, color2, color_shimmer FROM roles WHERE id = ?');
  for (const [discordId, havenId] of Object.entries(roleMapOf(db))) {
    const r = roleRow.get(Number(havenId));
    if (r) roles[discordId] = { name: r.name, roleId: r.id, color: r.color, color2: r.color2, color_shimmer: r.color_shimmer };
  }
  for (const c of db.prepare("SELECT id, discord_channel_id FROM channels WHERE is_dm = 0 AND discord_channel_id IS NOT NULL AND discord_channel_id != ''").all()) {
    channels[c.discord_channel_id] = { channelId: c.id };
  }
  return { users, roles, channels };
}

module.exports = { migrateBazaarDiscordRefs, saveName, idsIn, refsFor };
