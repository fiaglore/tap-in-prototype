// Working-hours rules for access groups. Days run Monday (0) to Sunday (6); times are minutes after
// local midnight in the workplace's own time zone (events.tz_offset_min).

import { HttpError } from './util.js';

export const ALL_DAYS = 127;

export function parseClock(value, label) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  const mins = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  if (!m || Number(m[2]) > 59 || mins > 1440) throw new HttpError(400, 'invalid_hours', `Enter the ${label} time as HH:MM.`);
  return mins;
}

// Accepts { days: [0..6], from: "08:00", to: "18:00" }; anything omitted means "always".
export function parseSchedule(t, name) {
  let mask = ALL_DAYS;
  if (t?.days !== undefined) {
    if (!Array.isArray(t.days) || !t.days.length || t.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new HttpError(400, 'invalid_days', `Choose at least one day for "${name}".`);
    }
    mask = t.days.reduce((m, d) => m | (1 << d), 0);
  }
  const from = t?.from === undefined || t.from === '' ? 0 : parseClock(t.from, 'start');
  const to = t?.to === undefined || t.to === '' ? 1440 : parseClock(t.to, 'end');
  if (from >= to) throw new HttpError(400, 'invalid_hours', `"${name}" must end after it starts (overnight shifts are not supported yet).`);
  return { days_mask: mask, from_min: from, to_min: to };
}

export const isAlways = (s) => s.days_mask === ALL_DAYS && s.from_min === 0 && s.to_min === 1440;

// Is `at` (unix seconds) inside the schedule, in a zone `tzOffsetMin` minutes east of UTC?
export function withinSchedule(s, at, tzOffsetMin = 60) {
  if (isAlways(s)) return true;
  const local = at + tzOffsetMin * 60;
  const dow = (Math.floor(local / 86400) + 3) % 7; // 1 Jan 1970 was a Thursday (3)
  const minute = Math.floor((((local % 86400) + 86400) % 86400) / 60);
  return !!(s.days_mask & (1 << dow)) && minute >= s.from_min && minute < s.to_min;
}

export const daysFromMask = (mask) => [0, 1, 2, 3, 4, 5, 6].filter((d) => mask & (1 << d));
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
export const scheduleOut = (t) => ({ days: daysFromMask(t.days_mask), from: hhmm(t.from_min), to: hhmm(t.to_min) });
