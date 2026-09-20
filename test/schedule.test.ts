import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSchedule, nextRun } from '../src/schedule.js';

test('defaults to Sunday at noon GMT and advances past an exact occurrence', () => {
  const sunday = Date.parse('2026-09-20T12:00:00Z');
  assert.equal(nextRun(defaultSchedule, Date.parse('2026-09-18T18:00:00Z')), sunday);
  assert.equal(nextRun(defaultSchedule, sunday), Date.parse('2026-09-27T12:00:00Z'));
});

test('keeps configured local time over both daylight saving transitions', () => {
  const schedule = { ...defaultSchedule, timezone: 'Europe/Amsterdam' };
  assert.equal(new Date(nextRun(schedule, Date.parse('2026-03-22T12:00:00Z'))).toISOString(), '2026-03-29T10:00:00.000Z');
  assert.equal(new Date(nextRun(schedule, Date.parse('2026-10-18T12:00:00Z'))).toISOString(), '2026-10-25T11:00:00.000Z');
});

test('rejects invalid timezones and schedule values', () => {
  assert.throws(() => nextRun({ ...defaultSchedule, timezone: 'Mars/Olympus' }, 0), /valid timezone/);
  assert.throws(() => nextRun({ ...defaultSchedule, hour: 24 }, 0), /Invalid weekly/);
  assert.throws(() => nextRun({ ...defaultSchedule, weekday: 7 }, 0), /Invalid weekly/);
});
