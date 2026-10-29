'use strict';

// Bizarre Bazaar fork: the Role Bot's socket side (see src/bazaarRoleBot.js).

const bot = require('../bazaarRoleBot');
const refs = require('../bazaarDiscordRefs');

module.exports = function register(socket, ctx) {
  const { db } = ctx;

  // Whether linking is set up and whether this person has linked yet. The
  // first-login pop-up and Settings → Connections both read this.
  socket.on('bazaar-discord-link-state', (_data, callback) => {
    if (typeof callback !== 'function') return;
    try { callback(bot.linkState(db, socket.user.id)); } catch (err) {
      console.warn('[role-bot] link state failed:', err.message);
      callback({ configured: false, linked: false });
    }
  });

  // Names for the Discord codes in copied history (src/bazaarDiscordRefs.js).
  socket.on('bazaar-discord-refs', (_data, callback) => {
    if (typeof callback !== 'function') return;
    try { callback(refs.refsFor(db)); } catch (err) {
      console.warn('[discord-refs] could not build the names:', err.message);
      callback({ users: {}, roles: {}, channels: {} });
    }
  });

  // Starts a link the way Steam and Spotify links start: a short-lived
  // connect token, opened by the client's connect-token handler.
  socket.on('bazaar-discord-link-start', () => {
    if (socket.user.isGuest) return socket.emit('error-msg', 'Guest accounts cannot link Discord');
    if (!bot.isConfigured(db)) return socket.emit('error-msg', 'Discord linking is not set up on this server');
    if (bot.linkState(db, socket.user.id).linked) return socket.emit('error-msg', 'Your Discord account is already linked');
    const { generateConnectToken } = require('../auth');
    socket.emit('connect-token', { provider: 'discord', token: generateConnectToken(socket.user.id, 'discord') });
  });

  // The admin can let someone link again, e.g. after they made a new
  // account. Roles already given stay.
  socket.on('bazaar-discord-link-reset', (data, callback) => {
    const cb = typeof callback === 'function' ? callback : () => {};
    if (!socket.user.isAdmin) return cb({ error: 'Only the admin can reset a Discord link' });
    const userId = Number(data && data.userId);
    if (!Number.isInteger(userId) || userId <= 0) return cb({ error: 'Invalid user' });
    cb({ success: true, reset: bot.resetLink(db, userId) });
  });
};
