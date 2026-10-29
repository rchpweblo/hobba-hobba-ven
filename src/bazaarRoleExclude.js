'use strict';
/**
 * Bizarre Bazaar fork: roles a channel is hidden from.
 *
 * channels.bazaar_role_exclude holds a JSON list of role ids (NULL means
 * none). Anyone holding one of those roles, server-wide or in that channel,
 * fails the channel's lock: roleGate.roleGateAllows turns them away, so the
 * channel leaves their list and every check built on it refuses them, like a
 * View Channel deny on a Discord role. Hidden wins over Required roles, as it
 * does on Discord. The admin is never hidden from anything.
 *
 * Kept in its own file so merging an upstream release only meets one-line
 * hooks (roleGate.js, database.js, socketHandlers/index.js and roles.js).
 */

function migrateBazaarRoleExclude(addColumn) {
  addColumn('channels', 'bazaar_role_exclude', 'TEXT DEFAULT NULL');
}

function parseExclude(raw) {
  if (!raw) return [];
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? [...new Set(v.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0))] : [];
  } catch { return []; } // malformed JSON hides the channel from nobody
}

// Most callers hand over a row with only id and role_gate, so the column is
// read by id when the row does not carry it.
function excludedRoles(db, channel) {
  if (!channel) return [];
  if (channel.bazaar_role_exclude !== undefined) return parseExclude(channel.bazaar_role_exclude);
  if (!channel.id) return [];
  let row;
  // A database without the column (upstream tests build their own) hides nothing.
  try { row = db.prepare('SELECT bazaar_role_exclude FROM channels WHERE id = ?').get(channel.id); } catch { return []; }
  return parseExclude(row && row.bazaar_role_exclude);
}

// True when this person is hidden from the channel.
function excludes(db, userId, channel) {
  const roles = excludedRoles(db, channel);
  if (!roles.length) return false;
  if (db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId)?.is_admin) return false;
  const ph = roles.map(() => '?').join(',');
  return !!db.prepare(`SELECT 1 FROM user_roles WHERE user_id = ? AND role_id IN (${ph}) AND (channel_id IS NULL OR channel_id = ?) LIMIT 1`)
    .get(userId, ...roles, channel.id || 0);
}

// A deleted role stops hiding anything.
function forgetRole(db, roleId) {
  for (const ch of db.prepare('SELECT id, bazaar_role_exclude FROM channels WHERE bazaar_role_exclude IS NOT NULL').all()) {
    const roles = parseExclude(ch.bazaar_role_exclude);
    if (!roles.includes(roleId)) continue;
    const rest = roles.filter(r => r !== roleId);
    db.prepare('UPDATE channels SET bazaar_role_exclude = ? WHERE id = ?').run(rest.length ? JSON.stringify(rest) : null, ch.id);
  }
}

module.exports = { migrateBazaarRoleExclude, parseExclude, excludedRoles, excludes, forgetRole };
