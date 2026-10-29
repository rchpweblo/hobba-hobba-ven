'use strict';

// Bizarre Bazaar fork: setting the roles a channel is hidden from
// (see src/bazaarRoleExclude.js).

const { parseExclude } = require('../bazaarRoleExclude');

module.exports = function register(socket, ctx) {
  const { io, db, broadcastChannelLists, emitOnlineUsers, logAudit } = ctx;
  const audit = typeof logAudit === 'function' ? logAudit : () => {};

  socket.on('bazaar-set-channel-role-exclude', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    // Hiding a channel from people is the admin's call, like making it private.
    if (!socket.user.isAdmin) return cb({ error: 'Only the admin can hide a channel from roles' });
    const code = typeof data.code === 'string' ? data.code.trim() : '';
    if (!/^[a-f0-9]{8}$/i.test(code)) return cb({ error: 'Channel not found' });
    const channel = db.prepare('SELECT id, code FROM channels WHERE code = ? AND is_dm = 0').get(code);
    if (!channel) return cb({ error: 'Channel not found' });

    let roles = parseExclude(Array.isArray(data.roles) ? data.roles.slice(0, 50) : []);
    if (roles.length) {
      const known = new Set(db.prepare(`SELECT id FROM roles WHERE id IN (${roles.map(() => '?').join(',')})`).all(...roles).map(r => r.id));
      roles = roles.filter(id => known.has(id));
    }
    const stored = roles.length ? JSON.stringify(roles) : null;
    try {
      db.prepare('UPDATE channels SET bazaar_role_exclude = ? WHERE id = ?').run(stored, channel.id);
    } catch (err) {
      console.error('Set role exclude error:', err);
      return cb({ error: 'Failed to save the hidden roles' });
    }

    // Memberships that came through Required roles follow the lock, and
    // anyone now hidden leaves the room straight away; the rebuilt lists take
    // the channel out of their sidebar.
    try { ctx.syncRoleGateMemberships({ channelId: channel.id }); } catch (err) { console.error('role gate membership sync failed:', err.message); }
    const fresh = db.prepare('SELECT id, role_gate, bazaar_role_exclude FROM channels WHERE id = ?').get(channel.id);
    for (const [, s] of io.sockets.sockets) {
      if (!s.user || s.user.isAdmin) continue;
      if (!ctx.roleGateAllows(s.user.id, fresh)) ctx.liveAccess?.cutOff(s.user.id, [channel.code], 'This channel is hidden from one of your roles');
    }
    broadcastChannelLists();
    if (typeof emitOnlineUsers === 'function') emitOnlineUsers(channel.code);
    cb({ success: true, roles });
    audit({ actor: socket.user, action: 'channel_role_exclude', target_type: 'channel', target_id: channel.id, target_name: code, details: { roles } });
  });
};
