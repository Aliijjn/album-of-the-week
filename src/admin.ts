import { UserError } from './store.js';

export function parseHistoryTime(value: string): number {
  const discord = /^<t:(-?\d+)(?::[tTdDfFRsS])?>$/.exec(value.trim());
  if (discord) {
    const timestamp = Number(discord[1]) * 1000;
    if (Number.isSafeInteger(timestamp) && Number.isFinite(new Date(timestamp).getTime())) return timestamp;
  }
  // Explicit offsets avoid guessing the user's timezone or misreading ambiguous local dates.
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/i.exec(value.trim());
  if (iso) {
    const [, year, month, day, hour, minute, second] = iso;
    const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    const timestamp = Date.parse(value.trim());
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days &&
      Number(hour) < 24 && Number(minute) < 60 && Number(second ?? 0) < 60 && Number.isFinite(timestamp)) return timestamp;
  }
  throw new UserError('Use a date with timezone, such as 2026-10-11T12:00+02:00, or a Discord timestamp.');
}
