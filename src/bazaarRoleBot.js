'use strict';
/**
 * Bizarre Bazaar fork: the Role Bot.
 *
 * A member links their Discord account once (src/bazaarDiscordLinkRoutes.js,
 * Discord OAuth with the identify scope, so Discord itself says who they
 * are). The Role Bot then reads their roles in the community's Discord server
 * through the Ferry bot and gives them the matching Haven roles, once:
 *
 *   - roles map by Discord role id to Haven role ids (rules installed with
 *     tools/bazaar-role-rules.js after the server templates are imported);
 *   - a channel-only role is given in each of its channels, never server-wide
 *     (a role given in a channel reaches its sub-channels by itself);
 *   - extra grants by Discord user id come on top;
 *   - someone the bot cannot find in the Discord server falls back to the
 *     snapshot taken when the server was copied.
 *
 * It only ever adds roles. Nothing is taken away, so the role every new
 * member gets stays, whatever they held on Discord.
 *
 * Rules (server_settings.bazaar_role_bot_rules, JSON):
 *   { guildId, roleMap: { discordRoleId: havenRoleId },
 *     channelOnly: { havenRoleId: [channelId] },
 *     extra: { discordUserId: [havenRoleId] },
 *     snapshot: { discordUserId: [discordRoleId] } }
 */

const RULES_KEY = 'bazaar_role_bot_rules';
const DISCORD_API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{5,25}$/;

function migrateBazaarRoleBot(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bazaar_discord_links (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      discord_id TEXT NOT NULL UNIQUE,
      discord_username TEXT,
      source TEXT NOT NULL,
      roles_given TEXT,
      linked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ── Server-level handles (set once by socketHandlers/index.js) ──────────
let handles = null;
function attach(h) { handles = h; }
function attached() { return handles; }

function clientId() { return (process.env.BAZAAR_DISCORD_CLIENT_ID || '').trim(); }
function clientSecret() { return (process.env.BAZAAR_DISCORD_CLIENT_SECRET || '').trim(); }

function setting(db, key) {
  const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(key);
  return row && typeof row.value === 'string' ? row.value : '';
}

function readRules(db) {
  try {
    const r = JSON.parse(setting(db, RULES_KEY) || 'null');
    return r && typeof r === 'object' && SNOWFLAKE.test(String(r.guildId)) ? r : null;
  } catch { return null; } // broken rules: the Role Bot stays off
}

// Everything the link needs: the Discord app's id and secret, the installed
// rules, and the Ferry bot's token to read roles with.
function isConfigured(db) {
  return !!(clientId() && clientSecret() && readRules(db) && setting(db, 'ferry_bot_token'));
}

function linkOf(db, userId) {
  return db.prepare('SELECT * FROM bazaar_discord_links WHERE user_id = ?').get(userId) || null;
}

function linkState(db, userId) {
  const link = linkOf(db, userId);
  let given = [];
  try { given = JSON.parse(link?.roles_given || '[]'); } catch { given = []; }
  return {
    configured: isConfigured(db),
    linked: !!link && link.source !== 'none',
    discordUsername: link ? link.discord_username : null,
    source: link ? link.source : null,
    given,
  };
}

// The member's role ids in the Discord server, or null when they are not in it.
async function fetchMemberRoles(db, discordId, fetchImpl = fetch) {
  const rules = readRules(db);
  const token = setting(db, 'ferry_bot_token');
  if (!rules || !token) throw new Error('Role Bot is not set up');
  const resp = await fetchImpl(`${DISCORD_API}/guilds/${rules.guildId}/members/${discordId}`, { headers: { Authorization: `Bot ${token}` } });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Discord answered ${resp.status}`);
  const member = await resp.json();
  return Array.isArray(member.roles) ? member.roles.map(String) : [];
}

const idList = (v) => (Array.isArray(v) ? v.map(Number).filter(n => Number.isInteger(n) && n > 0) : []);

// Give the roles, adding only. Returns what was new and what they had already.
function grantRoles(db, userId, roleIds, rules) {
  const given = [], already = [];
  const has = db.prepare('SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? AND channel_id IS ?');
  const add = db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id, granted_by) VALUES (?, ?, ?, NULL)');
  const chName = db.prepare('SELECT name FROM channels WHERE id = ? AND is_dm = 0');
  for (const roleId of [...new Set(roleIds)]) {
    const role = db.prepare('SELECT id, name, scope, link_channel_access FROM roles WHERE id = ?').get(roleId);
    if (!role) continue;
    const channels = idList(rules.channelOnly && rules.channelOnly[roleId]).filter(id => chName.get(id));
    // A channel role with no channels to go in has nowhere to be given.
    if (role.scope === 'channel' && !channels.length) continue;
    const places = channels.length ? channels : [null];
    let fresh = false;
    for (const ch of places) {
      if (has.get(userId, roleId, ch)) continue;
      add.run(userId, roleId, ch);
      fresh = true;
    }
    if (role.link_channel_access) {
      const ins = db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)');
      db.prepare('SELECT rca.channel_id FROM role_channel_access rca JOIN channels c ON c.id = rca.channel_id WHERE rca.role_id = ? AND rca.grant_on_promote = 1 AND c.is_dm = 0')
        .all(roleId).forEach(r => ins.run(r.channel_id, userId));
    }
    const entry = { name: role.name, ...(channels.length ? { channels: channels.map(id => chName.get(id).name) } : {}) };
    (fresh ? given : already).push(entry);
  }
  return { given, already };
}

/**
 * Link a Haven account to a Discord account and give the roles, once.
 * memberRoles: the Discord role ids from the server, or null when the bot
 * could not find them there (the snapshot is tried next).
 * Returns { error } or { source, given, already, unmapped }.
 */
function linkAndGrant(db, userId, { discordId, discordUsername, memberRoles }) {
  discordId = String(discordId || '');
  if (!SNOWFLAKE.test(discordId)) return { error: 'Discord did not say who you are' };
  const rules = readRules(db);
  if (!rules) return { error: 'The Role Bot is not set up on this server' };
  return db.transaction(() => {
    const user = db.prepare('SELECT id, is_guest FROM users WHERE id = ?').get(userId);
    if (!user) return { error: 'Account not found' };
    if (user.is_guest) return { error: 'Guest accounts cannot link Discord' };
    const mine = linkOf(db, userId);
    if (mine && mine.source !== 'none') return { error: 'Your Discord account is already linked, and its roles were already given' };
    const theirs = db.prepare('SELECT user_id FROM bazaar_discord_links WHERE discord_id = ?').get(discordId);
    if (theirs && theirs.user_id !== userId) return { error: 'That Discord account is already linked to another Haven account' };

    let discordRoles = Array.isArray(memberRoles) ? memberRoles.map(String) : null;
    let source = discordRoles ? 'discord' : 'none';
    if (!discordRoles && Array.isArray(rules.snapshot?.[discordId])) {
      discordRoles = rules.snapshot[discordId].map(String);
      source = 'snapshot';
    }
    discordRoles = (discordRoles || []).filter(r => r !== String(rules.guildId)); // @everyone
    const mapped = discordRoles.map(r => rules.roleMap?.[r]).filter(Boolean).map(Number);
    const unmapped = discordRoles.filter(r => !rules.roleMap?.[r]).length;
    const { given, already } = grantRoles(db, userId, [...mapped, ...idList(rules.extra?.[discordId])], rules);
    if (source === 'none' && (given.length || already.length)) source = 'extra';

    db.prepare(`INSERT INTO bazaar_discord_links (user_id, discord_id, discord_username, source, roles_given)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET discord_id = excluded.discord_id, discord_username = excluded.discord_username,
        source = excluded.source, roles_given = excluded.roles_given, linked_at = CURRENT_TIMESTAMP`)
      .run(userId, discordId, String(discordUsername || '').slice(0, 64), source, JSON.stringify(given));
    return { source, given, already, unmapped };
  })();
}

// After a grant: memberships that follow locks, then fresh roles and
// channel lists on every device the person has open.
function refreshAfterGrant(userId, result) {
  const h = handles;
  if (!h) return;
  try { h.syncRoleGateMemberships?.({ userId }); } catch (err) { console.warn('[role-bot] lock membership sync failed:', err.message); }
  try { h.roleRefresh?.pushUserRoleState?.(userId); } catch (err) { console.warn('[role-bot] role refresh failed:', err.message); }
  try { h.roleRefresh?.pushChannelList?.(userId); } catch (err) { console.warn('[role-bot] channel list refresh failed:', err.message); }
  for (const [, s] of h.io.sockets.sockets) {
    if (s.user && s.user.id === userId) s.emit('bazaar-role-bot-result', result);
  }
}

// ── Installing the rules (tools/bazaar-role-rules.js) ───────────────────
// The rules file names roles and channels as they are in Haven; they are
// stored by id so renaming a role or channel later does not break them.
function installRules(db, input) {
  const problems = [];
  if (!input || !SNOWFLAKE.test(String(input.guildId))) throw new Error('rules need a guildId');
  const roleId = (name) => {
    const rows = db.prepare('SELECT id FROM roles WHERE name = ? COLLATE NOCASE').all(String(name));
    if (rows.length !== 1) { problems.push(`role "${name}": ${rows.length ? 'more than one has this name' : 'not found'}`); return null; }
    return rows[0].id;
  };
  const channelId = (path) => {
    const [a, b] = String(path).split('/');
    const top = db.prepare('SELECT id FROM channels WHERE name = ? COLLATE NOCASE AND parent_channel_id IS NULL AND is_dm = 0').all(a);
    if (top.length !== 1) { problems.push(`channel "${path}": ${top.length ? 'more than one' : 'not found'}`); return null; }
    if (b === undefined) return top[0].id;
    const sub = db.prepare('SELECT id FROM channels WHERE name = ? COLLATE NOCASE AND parent_channel_id = ?').all(b, top[0].id);
    if (sub.length !== 1) { problems.push(`channel "${path}": ${sub.length ? 'more than one' : 'not found'}`); return null; }
    return sub[0].id;
  };
  const out = { guildId: String(input.guildId), roleMap: {}, channelOnly: {}, extra: {}, snapshot: {} };
  for (const [d, name] of Object.entries(input.roleMap || {})) { const id = roleId(name); if (id) out.roleMap[d] = id; }
  for (const [name, chans] of Object.entries(input.channelOnly || {})) {
    const id = roleId(name);
    const ids = (chans || []).map(channelId).filter(Boolean);
    if (id) out.channelOnly[id] = ids;
  }
  for (const [d, names] of Object.entries(input.extra || {})) out.extra[d] = (names || []).map(roleId).filter(Boolean);
  for (const [d, roles] of Object.entries(input.snapshot || {})) if (SNOWFLAKE.test(d) && Array.isArray(roles)) out.snapshot[d] = roles.map(String);
  if (problems.length) {
    const err = new Error(`rules not installed:\n  ${problems.join('\n  ')}`);
    err.problems = problems;
    throw err;
  }
  db.prepare('INSERT OR REPLACE INTO server_settings (key, value) VALUES (?, ?)').run(RULES_KEY, JSON.stringify(out));
  return { roles: Object.keys(out.roleMap).length, channelOnly: Object.keys(out.channelOnly).length, extra: Object.keys(out.extra).length, snapshot: Object.keys(out.snapshot).length };
}

// Lets someone link again (their roles stay; linking adds only).
function resetLink(db, userId) {
  return db.prepare('DELETE FROM bazaar_discord_links WHERE user_id = ?').run(userId).changes > 0;
}

module.exports = {
  RULES_KEY, migrateBazaarRoleBot, attach, attached, clientId, clientSecret, readRules, isConfigured,
  linkOf, linkState, fetchMemberRoles, grantRoles, linkAndGrant, refreshAfterGrant, installRules, resetLink,
};
