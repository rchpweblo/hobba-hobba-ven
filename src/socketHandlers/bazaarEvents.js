'use strict';

// Bizarre Bazaar fork: scheduled events' socket side (see src/bazaarEvents.js).

const events = require('../bazaarEvents');

module.exports = function register(socket, ctx) {
  const { db, userHasPermission } = ctx;
  const perm = (userId, p, channelId) => userHasPermission(userId, p, channelId || null);
  const me = () => socket.user;
  const reply = (cb, fn) => {
    if (typeof cb !== 'function') return;
    try { cb(fn()); } catch (err) {
      console.warn('[events]', err.message);
      cb({ error: 'Something went wrong' });
    }
  };

  // The events this person can see, and where they may create one.
  socket.on('bazaar-events-list', (_data, cb) => reply(cb, () => ({
    events: events.listFor(db, perm, me()),
    create: events.createOptions(db, perm, me()),
  })));

  socket.on('bazaar-event-save', (data, cb) => reply(cb, () => {
    const r = events.saveEvent(db, perm, me(), data);
    return r.error ? r : { event: events.serialize(db, perm, me(), r.event) };
  }));

  socket.on('bazaar-event-interest', (data, cb) => reply(cb, () => events.setInterest(db, me(), data && data.id, !!(data && data.on))));

  socket.on('bazaar-event-interested', (data, cb) => reply(cb, () => {
    const people = events.interestedNames(db, me(), data && data.id);
    return people ? { people } : { error: 'That event is gone' };
  }));

  // start | end | skip | cancel
  socket.on('bazaar-event-action', (data, cb) => reply(cb, () => events.act(db, perm, me(), data && data.id, data && data.action)));
};
