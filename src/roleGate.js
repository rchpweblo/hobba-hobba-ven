'use strict';

// ── Role gate ───────────────────────────────────────────
// A channel's role_gate is JSON {mode:'any'|'all', roles:[ids]}. Empty or
// malformed means no gate. Roles held server-wide count, and so does a
// channel-scoped grant of the same role inside this very channel.
// Kept outside the socket permission factory so code without a socket
// context (bot voice, bot callbacks) applies the very same rule.
function parseRoleGate(raw) {
  if (!raw) return null;
  try {
    const g = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const roles = Array.isArray(g && g.roles)
      ? [...new Set(g.roles.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0))]
      : [];
    if (!roles.length) return null;
    return { mode: g.mode === 'all' ? 'all' : 'any', roles };
  } catch { return null; } // malformed JSON is documented above as "no gate"
}

function roleGateAllows(db, userId, channel) {
  // Bizarre Bazaar fork: roles the channel is hidden from (src/bazaarRoleExclude.js).
  if (require('./bazaarRoleExclude').excludes(db, userId, channel)) return false;
  const gate = parseRoleGate(channel && channel.role_gate);
  if (!gate) return true;
  const held = new Set(
    db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? AND (channel_id IS NULL OR channel_id = ?)')
      .all(userId, channel.id || 0).map(r => r.role_id)
  );
  return gate.mode === 'all' ? gate.roles.every(r => held.has(r)) : gate.roles.some(r => held.has(r));
}

module.exports = { parseRoleGate, roleGateAllows };
