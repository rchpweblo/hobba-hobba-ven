'use strict';

// Bizarre Bazaar fork: banner messages' socket side (see src/bazaarBanners.js).
//
//   bazaar:get-banner   { code, topicId? }                 → bazaar:banner
//   bazaar:set-banner   { code, topicId?, title, body, nsfw } (cb { ok } or { error })
//   bazaar:clear-banner { code, topicId? }                   (cb { ok } or { error })
//
// A change goes to everyone in the channel as bazaar:banner
// { code, topicId, banner } (banner null when removed).

const banners = require('../bazaarBanners');
const { sanitizeText } = require('./helpers');

module.exports = function register(socket, ctx) {
  const { io, db, userHasPermission, roleGateAllows } = ctx;
  const me = () => socket.user;

  // Can read the channel: a member through its gate, or the admin.
  const canSee = (ch) => {
    if (me().isAdmin) return true;
    if (!db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(ch.id, me().id)) return false;
    return roleGateAllows(me().id, db.prepare('SELECT id, role_gate FROM channels WHERE id = ?').get(ch.id));
  };
  // As Channel Functions (_canManageSettingsOf in channels.js), and a forum
  // post's starter for their own post.
  const canSet = (place) => {
    if (!canSee(place.channel)) return false;
    if (me().isAdmin || userHasPermission(me().id, 'manage_channel_settings', place.channel.id)) return true;
    return !!(place.topic && place.topic.user_id === me().id);
  };
  const placeFrom = (data) => (data && typeof data === 'object'
    ? banners.placeOf(db, data.code, data.topicId == null ? null : Number(data.topicId))
    : null);
  const answer = (cb, value) => { if (typeof cb === 'function') cb(value); };
  const announce = (place) => {
    io.to(`channel:${place.channel.code}`).emit('bazaar:banner', {
      code: place.channel.code, topicId: place.topic ? place.topic.id : null, banner: banners.get(db, place),
    });
  };

  socket.on('bazaar:get-banner', (data) => {
    const place = placeFrom(data);
    if (!place || !canSee(place.channel)) return;
    socket.emit('bazaar:banner', {
      code: place.channel.code, topicId: place.topic ? place.topic.id : null,
      banner: banners.get(db, place), canSet: canSet(place),
    });
  });

  socket.on('bazaar:set-banner', (data, cb) => {
    try {
      const place = placeFrom(data);
      if (!place) return answer(cb, { error: 'There is no such channel or post' });
      if (!canSet(place)) return answer(cb, { error: 'You don\'t have permission to set this banner' });
      const r = banners.save(db, place, me().id, data, sanitizeText);
      if (r.error) return answer(cb, r);
      announce(place);
      answer(cb, { ok: true });
    } catch (err) {
      console.warn('[banners]', err.message);
      answer(cb, { error: 'Something went wrong' });
    }
  });

  socket.on('bazaar:clear-banner', (data, cb) => {
    try {
      const place = placeFrom(data);
      if (!place) return answer(cb, { error: 'There is no such channel or post' });
      if (!canSet(place)) return answer(cb, { error: 'You don\'t have permission to remove this banner' });
      if (banners.remove(db, place)) announce(place);
      answer(cb, { ok: true });
    } catch (err) {
      console.warn('[banners]', err.message);
      answer(cb, { error: 'Something went wrong' });
    }
  });
};
