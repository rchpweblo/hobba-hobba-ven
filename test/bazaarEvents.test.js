'use strict';

// Bizarre Bazaar fork: scheduled events (src/bazaarEvents.js): who may see
// and do what, the Interested list, starting and its notifications, and the
// clock that ends, misses and repeats events.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.HAVEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-events-'));
process.env.JWT_SECRET = process.env.JWT_SECRET || 'j'.repeat(64);
const { initDatabase } = require('../src/database');
const createPermissions = require('../src/socketHandlers/permissions');
const events = require('../src/bazaarEvents');
const db = initDatabase();
const { userHasPermission } = createPermissions(db);
const perm = (id, p, ch) => userHasPermission(id, p, ch || null);

const HOUR = 3600000;
let nextUser = 1;
const user = (name, { admin = false, guest = false } = {}) => {
  const id = nextUser++;
  db.prepare('INSERT INTO users (id, username, password_hash, is_admin, is_guest) VALUES (?, ?, ?, ?, ?)').run(id, name, 'x', admin ? 1 : 0, guest ? 1 : 0);
  return { id, username: name, isAdmin: admin, isGuest: guest };
};
const channel = (name, voice = 1) => db.prepare('INSERT INTO channels (name, code, voice_enabled) VALUES (?, ?, ?)')
  .run(name, Math.random().toString(36).slice(2, 10), voice).lastInsertRowid;
const join = (u, ch) => db.prepare('INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)').run(ch, u.id);
const role = (name, scope, perms) => {
  const id = db.prepare('INSERT INTO roles (name, level, scope) VALUES (?, 10, ?)').run(name, scope).lastInsertRowid;
  perms.forEach((p) => db.prepare('INSERT INTO role_permissions (role_id, permission, allowed) VALUES (?, ?, 1)').run(id, p));
  return id;
};
const give = (u, roleId, ch = null) => db.prepare('INSERT INTO user_roles (user_id, role_id, channel_id) VALUES (?, ?, ?)').run(u.id, roleId, ch);

const C = { voice: channel('A Fleeting Reminiscence'), table: channel('tabletops', 0), secret: channel('mod-lounge', 0) };
const admin = user('admin', { admin: true });
const host = user('host');      // Create Events server-wide
const gm = user('gm');          // Create Events only in #tabletops
const boss = user('boss');      // Manage Events server-wide
const member = user('member');
const outsider = user('outsider'); // not in the voice channel
const guest = user('guest', { guest: true });
give(host, role('Event Host', 'server', ['create_events']));
give(gm, role('Game Master', 'channel', ['create_events']), C.table);
give(boss, role('Event Boss', 'server', ['manage_events']));
for (const u of [host, gm, boss, member, guest]) { join(u, C.voice); join(u, C.table); }
join(outsider, C.table);

// The live parts: who got a pop-up, and who was pushed.
const popups = [], pushes = [];
const sockets = new Map();
const connect = (u) => sockets.set(u.id, { user: u, emit: (ev, payload) => popups.push({ to: u.id, ev, payload }) });
[host, gm, boss, member, outsider].forEach(connect);
const voiceUsers = new Map();
events.attach({
  io: { sockets: { sockets }, emit: () => {} }, db, state: { voiceUsers },
  sendPushNotifications: (...args) => pushes.push(args),
});

test.after(() => {
  events.detach();
  db.close();
  fs.rmSync(process.env.HAVEN_DATA_DIR, { recursive: true, force: true });
  // auth.js keeps timers running; as in bazaarThreadChannel.test.js.
  setImmediate(() => process.exit(0));
});

const T0 = Date.now() + 2 * HOUR;
const draft = (over = {}) => ({ name: 'Icewind Dale Gaming', description: '4 daves', channelId: C.voice, startAt: T0, repeat: 'none', tz: 'America/Los_Angeles', ...over });
const ev = (id) => events.getEvent(db, id);

test('Create Events lets someone create; nobody else can', () => {
  assert.ok(events.saveEvent(db, perm, host, draft()).event);
  assert.match(events.saveEvent(db, perm, member, draft()).error, /cannot create events/);
  assert.match(events.saveEvent(db, perm, guest, draft()).error, /cannot create events/);
});

test('a role held in one channel lets someone create events in that channel only', () => {
  assert.ok(events.saveEvent(db, perm, gm, draft({ channelId: C.table })).event);
  assert.match(events.saveEvent(db, perm, gm, draft()).error, /cannot create events in that channel/);
  const where = events.createOptions(db, perm, gm);
  assert.deepEqual(where.channels.map((c) => c.id), [C.table]);
  assert.equal(where.elsewhere, false);
});

test('nobody can put an event in a channel they are not in, except the admin', () => {
  assert.match(events.saveEvent(db, perm, host, draft({ channelId: C.secret })).error, /not in that channel/);
  assert.ok(events.saveEvent(db, perm, admin, draft({ channelId: C.secret, name: 'Mod meeting' })).event);
});

test('the input is checked', () => {
  assert.match(events.saveEvent(db, perm, host, draft({ name: '  ' })).error, /needs a name/);
  assert.match(events.saveEvent(db, perm, host, draft({ startAt: Date.now() - HOUR })).error, /already passed/);
  assert.match(events.saveEvent(db, perm, host, draft({ endAt: T0 - 1 })).error, /end must be after/);
  assert.match(events.saveEvent(db, perm, host, draft({ channelId: null, location: 'Minecraft' })).error, /needs an end time/);
  assert.match(events.saveEvent(db, perm, host, draft({ image: 'https://evil.example/x.png' })).error, /uploaded to Haven/);
  assert.ok(events.saveEvent(db, perm, host, draft({ image: '/uploads/cover-1.png', repeat: 'fortnightly' })).event.repeat === 'none');
});

test('events in a channel are seen by its members only; others by everyone but guests', () => {
  const secret = events.listFor(db, perm, admin).find((e) => e.name === 'Mod meeting');
  assert.ok(secret);
  assert.ok(!events.listFor(db, perm, member).some((e) => e.name === 'Mod meeting'));
  const outside = events.saveEvent(db, perm, host, draft({ channelId: null, location: 'Minecraft', endAt: T0 + HOUR, name: 'Build night' })).event;
  assert.ok(events.listFor(db, perm, outsider).some((e) => e.id === outside.id));
  assert.ok(!events.listFor(db, perm, guest).some((e) => e.id === outside.id));
  assert.ok(!events.listFor(db, perm, outsider).some((e) => e.channel && e.channel.id === C.voice));
});

test('the creator may change their own event; Manage Events may change anyone\'s', () => {
  const id = events.saveEvent(db, perm, host, draft({ name: 'Mine' })).event.id;
  assert.ok(events.saveEvent(db, perm, host, draft({ id, name: 'Mine, renamed' })).event);
  assert.match(events.saveEvent(db, perm, member, draft({ id, name: 'Hijacked' })).error, /cannot edit/);
  assert.match(events.saveEvent(db, perm, gm, draft({ id, name: 'Hijacked' })).error, /cannot edit/);
  assert.ok(events.saveEvent(db, perm, boss, draft({ id, name: 'Fixed by boss' })).event);
  assert.match(events.act(db, perm, member, id, 'cancel').error, /cannot change/);
  assert.ok(events.act(db, perm, boss, id, 'cancel').ok);
  assert.equal(ev(id).status, 'canceled');
});

test('the creator is Interested; others mark and unmark themselves', () => {
  const id = events.saveEvent(db, perm, host, draft({ name: 'Interest test' })).event.id;
  assert.ok(events.setInterest(db, member, id, true).ok);
  assert.deepEqual(events.interestedNames(db, member, id).map((p) => p.name).sort(), ['host', 'member']);
  assert.ok(events.setInterest(db, member, id, false).ok);
  assert.match(events.setInterest(db, outsider, id, true).error, /gone/); // cannot see it
  assert.equal(events.interestedNames(db, outsider, id), null);
});

test('Start: Interested people who can see it get a pop-up, and a push', () => {
  const id = events.saveEvent(db, perm, host, draft({ name: 'Start test' })).event.id;
  events.setInterest(db, member, id, true);
  db.prepare('INSERT INTO bazaar_event_interest (event_id, user_id) VALUES (?, ?)').run(id, outsider.id); // e.g. left the channel since
  popups.length = 0; pushes.length = 0;
  assert.match(events.act(db, perm, member, id, 'start').error, /cannot change/);
  assert.ok(events.act(db, perm, host, id, 'start').ok);
  assert.equal(ev(id).status, 'active');
  const got = popups.filter((p) => p.ev === 'bazaar-event-started').map((p) => p.to).sort();
  assert.deepEqual(got, [host.id, member.id].sort());
  assert.equal(pushes.length, 1);
  const [channelId, , , starter, title, body, opts] = pushes[0];
  assert.equal(channelId, C.voice);
  assert.equal(starter, host.id);
  assert.equal(title, '📅 Start test');
  assert.equal(body, 'Starting now');
  assert.deepEqual(opts.onlyUserIds.sort(), [host.id, member.id, outsider.id].sort()); // the push only reaches channel members
  assert.match(opts.pingText, /@member/);
  assert.match(events.act(db, perm, host, id, 'start').error, /already started/);
});

test('a live event with no end time ends after 30 minutes with nobody in voice', () => {
  const id = events.saveEvent(db, perm, host, draft({ name: 'Idle test' })).event.id;
  const t = Date.now();
  events.act(db, perm, host, id, 'start', t);
  const code = db.prepare('SELECT code FROM channels WHERE id = ?').get(C.voice).code;
  voiceUsers.set(code, new Map([[member.id, {}]]));
  events.sweep(t + 40 * 60000); // someone is in voice: still live
  assert.equal(ev(id).status, 'active');
  voiceUsers.delete(code);
  events.sweep(t + 60 * 60000); // empty, but only for 20 minutes
  assert.equal(ev(id).status, 'active');
  events.sweep(t + 71 * 60000);
  assert.equal(ev(id).status, 'completed');
});

test('a live event ends at its end time; a repeating one moves to its next date and keeps its Interested', () => {
  const start = Date.now() + HOUR;
  // UTC: clock changes are the time tests' job.
  const id = events.saveEvent(db, perm, host, draft({ name: 'Weekly', startAt: start, endAt: start + 2 * HOUR, repeat: 'weekly', tz: 'UTC' })).event.id;
  const saved = ev(id).start_at; // whole minutes
  assert.equal(saved % 60000, 0);
  events.setInterest(db, member, id, true);
  events.act(db, perm, host, id, 'start', start);
  events.sweep(start + 2 * HOUR);
  const after = ev(id);
  assert.equal(after.status, 'scheduled');
  assert.equal(after.start_at - saved, 7 * 24 * HOUR);
  assert.equal(after.end_at - after.start_at, 2 * HOUR);
  assert.ok(events.interestedNames(db, member, id).some((p) => p.name === 'member'));
});

test('a channel event nobody started is missed after 12 hours: a one-off is cancelled, a repeating one moves on', () => {
  const once = events.saveEvent(db, perm, host, draft({ name: 'Missed once' })).event.id;
  const weekly = events.saveEvent(db, perm, host, draft({ name: 'Missed weekly', repeat: 'weekly' })).event.id;
  events.sweep(T0 + 11 * HOUR);
  assert.equal(ev(once).status, 'scheduled');
  events.sweep(T0 + 12 * HOUR);
  assert.equal(ev(once).status, 'canceled');
  assert.equal(ev(weekly).status, 'scheduled');
  assert.ok(ev(weekly).start_at > T0 + 12 * HOUR);
});

test('an event somewhere else starts and ends by itself', () => {
  const id = events.saveEvent(db, perm, host, draft({ channelId: null, location: 'Minecraft', name: 'Auto', startAt: T0, endAt: T0 + HOUR })).event.id;
  events.setInterest(db, outsider, id, true);
  popups.length = 0; pushes.length = 0;
  events.sweep(T0);
  assert.equal(ev(id).status, 'active');
  assert.ok(popups.some((p) => p.to === outsider.id && p.ev === 'bazaar-event-started' && p.payload.location === 'Minecraft'));
  assert.equal(pushes.length, 0, 'no channel to push through');
  events.sweep(T0 + HOUR);
  assert.equal(ev(id).status, 'completed');
});

test('Skip moves a repeating event to its next date; a one-off cannot skip', () => {
  const weekly = events.saveEvent(db, perm, host, draft({ name: 'Skippable', repeat: 'biweekly' })).event.id;
  events.act(db, perm, host, weekly, 'skip');
  assert.equal(ev(weekly).status, 'scheduled');
  assert.ok(ev(weekly).start_at > T0 + 13 * 24 * HOUR);
  const once = events.saveEvent(db, perm, host, draft({ name: 'Once' })).event.id;
  assert.match(events.act(db, perm, host, once, 'skip').error, /Only a repeating event/);
});

test('people Interested on Discord become Interested here when they link, if they can see the event', () => {
  const id = events.saveEvent(db, perm, admin, draft({ name: 'From Discord' })).event.id;
  db.prepare('INSERT INTO bazaar_event_discord_interest (event_id, discord_id) VALUES (?, ?), (?, ?)').run(id, '300000000000000001', id, '300000000000000002');
  assert.equal(events.claimDiscordInterest(db, member.id, '300000000000000001'), 1);
  assert.equal(events.claimDiscordInterest(db, outsider.id, '300000000000000002'), 0); // not in that channel
  assert.deepEqual(events.interestedNames(db, admin, id).map((p) => p.name).sort(), ['admin', 'member']);
});

test('cover uploads are open to people who can create events somewhere', () => {
  assert.equal(events.canCreateAnywhere(db, host.id), true);
  assert.equal(events.canCreateAnywhere(db, gm.id), true);
  assert.equal(events.canCreateAnywhere(db, member.id), false);
  assert.equal(events.canCreateAnywhere(db, guest.id), false);
});
