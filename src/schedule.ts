import { CronExpressionParser } from 'cron-parser';

export interface Schedule {
  weekday: number;
  hour: number;
  minute: number;
  timezone: string;
}

export const defaultSchedule: Schedule = { weekday: 0, hour: 12, minute: 0, timezone: 'UTC' };

export function validateSchedule(schedule: Schedule): void {
  for (const [value, max] of [[schedule.weekday, 6], [schedule.hour, 23], [schedule.minute, 59]] as const) {
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error('Invalid weekly schedule.');
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format();
  } catch {
    throw new Error('Use a valid timezone, such as UTC or Europe/Amsterdam.');
  }
}

export function nextRun(schedule: Schedule, after: number): number {
  validateSchedule(schedule);
  return CronExpressionParser.parse(`0 ${schedule.minute} ${schedule.hour} * * ${schedule.weekday}`, {
    currentDate: new Date(after), tz: schedule.timezone,
  }).next().getTime();
}
