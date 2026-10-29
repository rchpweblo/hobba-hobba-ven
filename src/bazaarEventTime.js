'use strict';
/**
 * Bizarre Bazaar fork: dates for repeating events (src/bazaarEvents.js).
 *
 * An event repeats in its own time zone's wall-clock time, so a weekly
 * 7 pm event stays at 7 pm after the clocks change. Times are stored as UTC
 * milliseconds plus an IANA zone; everything here is pure.
 *
 * Repeats (Discord's choices):
 *   none, weekly, biweekly (every other week), monthly (the nth weekday,
 *   or the last one when the first date fell in the month's fifth week),
 *   yearly (same month and day), weekdays (Monday to Friday).
 */

const REPEATS = ['none', 'weekly', 'biweekly', 'monthly', 'yearly', 'weekdays'];
const DAY = 86400000;

function validZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const formatters = new Map();
function wallParts(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) if (type !== 'literal') p[type] = Number(value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

// The UTC instant that shows as this wall-clock time in tz. A time the clocks
// skip (spring forward) lands just after the gap.
function zonedToUtc({ y, mo, d, h, mi, s = 0 }, tz) {
  const want = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = want;
  for (let i = 0; i < 4; i++) {
    const p = wallParts(guess, tz);
    const diff = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - want;
    if (!diff) return guess;
    guess -= diff;
  }
  return guess;
}

// Calendar helpers on plain dates (no zone involved).
const dateOf = (y, mo, d) => { const t = new Date(Date.UTC(y, mo - 1, d)); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const weekdayOf = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0 Sunday
const daysIn = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
function nthWeekday(y, mo, wd, n) { // n 1..4, or 5 for the last
  if (n >= 5) {
    const last = daysIn(y, mo);
    return last - ((weekdayOf(y, mo, last) - wd + 7) % 7);
  }
  return 1 + ((wd - weekdayOf(y, mo, 1) + 7) % 7) + (n - 1) * 7;
}

/** The series' dates in order, from the first one, as wall-clock dates. */
function* seriesDates(first, repeat) {
  const { y, mo, d } = first;
  if (repeat === 'weekly' || repeat === 'biweekly') {
    const step = repeat === 'weekly' ? 7 : 14;
    for (let k = 1; ; k++) yield dateOf(y, mo, d + k * step);
  } else if (repeat === 'weekdays') {
    for (let k = 1; ; k++) {
      const t = dateOf(y, mo, d + k);
      const wd = weekdayOf(t.y, t.mo, t.d);
      if (wd !== 0 && wd !== 6) yield t;
    }
  } else if (repeat === 'monthly') {
    const wd = weekdayOf(y, mo, d), n = Math.ceil(d / 7);
    for (let k = 1; ; k++) {
      const m = dateOf(y, mo + k, 1);
      yield { y: m.y, mo: m.mo, d: nthWeekday(m.y, m.mo, wd, n) };
    }
  } else if (repeat === 'yearly') {
    for (let k = 1; ; k++) if (d <= daysIn(y + k, mo)) yield { y: y + k, mo, d }; // 29 February: leap years only
  }
}

/**
 * The first occurrence of the series strictly after `afterMs`, or null for a
 * series that does not repeat. seriesStart is the first occurrence.
 */
function occurrenceAfter(seriesStart, repeat, tz, afterMs) {
  if (!REPEATS.includes(repeat) || repeat === 'none') return null;
  const first = wallParts(seriesStart, tz);
  const ms = ((seriesStart % 1000) + 1000) % 1000; // wallParts stops at seconds
  let n = 0;
  for (const date of seriesDates(first, repeat)) {
    const at = zonedToUtc({ ...date, h: first.h, mi: first.mi, s: first.s }, tz) + ms;
    if (at > afterMs) return at;
    if (++n > 50000) return null; // about 190 years of weekdays
  }
  return null;
}

module.exports = { REPEATS, DAY, validZone, wallParts, zonedToUtc, nthWeekday, occurrenceAfter };
