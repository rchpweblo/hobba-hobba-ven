'use strict';

// Bizarre Bazaar fork: repeating event dates keep their wall-clock time
// across daylight saving changes (src/bazaarEventTime.js).

const assert = require('node:assert/strict');
const test = require('node:test');
const { occurrenceAfter, zonedToUtc, wallParts, validZone, nthWeekday, seriesDateNear } = require('../src/bazaarEventTime');

const LA = 'America/Los_Angeles', LONDON = 'Europe/London';
const Z = (iso) => Date.parse(iso);
const next = (first, repeat, tz, after = first) => new Date(occurrenceAfter(Z(first), repeat, tz, Z(after))).toISOString();

test('a weekly 7 pm event stays at 7 pm when the clocks go back (autumn)', () => {
  // Sat 31 Oct 2026, 7 pm PDT; clocks go back on Sun 1 Nov.
  assert.equal(next('2026-10-25T02:00:00Z', 'weekly', LA), '2026-11-01T02:00:00.000Z');
  assert.equal(next('2026-10-25T02:00:00Z', 'weekly', LA, '2026-11-01T02:00:00Z'), '2026-11-08T03:00:00.000Z'); // 7 pm PST
});

test('and when the clocks go forward (spring)', () => {
  // Sat 7 Mar 2026, 7 pm PST; clocks go forward on Sun 8 Mar.
  assert.equal(next('2026-03-08T03:00:00Z', 'weekly', LA), '2026-03-15T02:00:00.000Z'); // 7 pm PDT
});

test('the same in another zone with other change dates', () => {
  // Sat 24 Oct 2026, 8 pm BST; British clocks go back on Sun 25 Oct.
  assert.equal(next('2026-10-24T19:00:00Z', 'weekly', LONDON), '2026-10-31T20:00:00.000Z');
});

test('every other week skips a week', () => {
  assert.equal(next('2026-10-25T02:00:00Z', 'biweekly', LA), '2026-11-08T03:00:00.000Z');
  assert.equal(next('2026-10-25T02:00:00Z', 'biweekly', LA, '2026-11-08T03:00:00Z'), '2026-11-22T03:00:00.000Z');
});

test('monthly on the nth weekday, and on the last one', () => {
  // Sat 7 Nov 2026 is the first Saturday; the next first Saturday is 5 Dec.
  assert.equal(next('2026-11-08T03:00:00Z', 'monthly', LA), '2026-12-06T03:00:00.000Z');
  // Fri 30 Oct 2026 is in the fifth week, so it repeats on the last Friday: 27 Nov.
  assert.equal(next('2026-10-31T02:00:00Z', 'monthly', LA), '2026-11-28T03:00:00.000Z');
  assert.equal(nthWeekday(2026, 11, 5, 5), 27);
  assert.equal(nthWeekday(2026, 12, 6, 1), 5);
});

test('yearly, with 29 February only in leap years', () => {
  assert.equal(next('2026-11-08T03:00:00Z', 'yearly', LA), '2027-11-08T03:00:00.000Z');
  assert.equal(next('2028-02-29T20:00:00Z', 'yearly', 'UTC'), '2032-02-29T20:00:00.000Z');
});

test('every weekday skips the weekend', () => {
  // Fri 30 Oct 2026, 9 am PDT; next is Mon 2 Nov, 9 am PST.
  assert.equal(next('2026-10-30T16:00:00Z', 'weekdays', LA), '2026-11-02T17:00:00.000Z');
});

test('a series long in the past gives its next date after now', () => {
  const at = occurrenceAfter(Z('2020-01-04T03:00:00Z'), 'weekly', LA, Z('2026-10-29T12:00:00Z'));
  assert.equal(new Date(at).toISOString(), '2026-10-31T02:00:00.000Z');
});

test('milliseconds in the first date are kept', () => {
  assert.equal(occurrenceAfter(Z('2026-10-25T02:00:00.250Z'), 'weekly', LA, Z('2026-10-25T02:00:00.250Z')) % 1000, 250);
});

test('a Discord series keeps its first local time: Icewind Dale stays at 6:21 pm', () => {
  // First date Fri 14 Aug 2026, 6:21 pm PDT; Discord (UTC) shows Fri 6 Nov at 5:21 pm PST.
  const at = seriesDateNear(Z('2026-08-15T01:21:00Z'), 'biweekly', LA, Z('2026-11-07T01:21:00Z'));
  assert.equal(new Date(at).toISOString(), '2026-11-07T02:21:00.000Z'); // 6:21 pm PST, still every other Friday
  assert.equal(seriesDateNear(Z('2026-11-07T02:21:00Z'), 'weekly', LA, Z('2026-11-07T01:21:00Z')), Z('2026-11-07T02:21:00Z'));
});

test('no repeat gives no next date', () => {
  assert.equal(occurrenceAfter(Z('2026-10-25T02:00:00Z'), 'none', LA, Z('2026-10-25T02:00:00Z')), null);
  assert.equal(occurrenceAfter(Z('2026-10-25T02:00:00Z'), 'hourly', LA, Z('2026-10-25T02:00:00Z')), null);
});

test('wall-clock conversion round-trips, and a skipped hour lands just after', () => {
  const at = zonedToUtc({ y: 2026, mo: 7, d: 4, h: 21, mi: 30 }, LA);
  assert.equal(new Date(at).toISOString(), '2026-07-05T04:30:00.000Z');
  assert.deepEqual(wallParts(at, LA), { y: 2026, mo: 7, d: 4, h: 21, mi: 30, s: 0 });
  const gap = zonedToUtc({ y: 2026, mo: 3, d: 8, h: 2, mi: 30 }, LA); // 2:30 am does not exist that day
  assert.ok(gap >= Z('2026-03-08T09:30:00Z') && gap <= Z('2026-03-08T10:30:00Z'));
});

test('zones are checked', () => {
  assert.equal(validZone(LA), true);
  assert.equal(validZone('Not/AZone'), false);
  assert.equal(validZone(''), false);
});
