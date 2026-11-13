const relative = new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'narrow' });
const exact = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * How long ago `date` was, as of `now`, in the design system's list style ("3h ago", "2d ago").
 * A future date (clock skew) counts as just now.
 */
export function formatTimeAgo(date: Date, now: number): string {
  const seconds = Math.max(1, Math.floor((now - date.getTime()) / 1000));
  if (seconds < MINUTE) return relative.format(-seconds, 'second');
  if (seconds < HOUR) return relative.format(-Math.floor(seconds / MINUTE), 'minute');
  if (seconds < DAY) return relative.format(-Math.floor(seconds / HOUR), 'hour');
  if (seconds < WEEK) return relative.format(-Math.floor(seconds / DAY), 'day');
  if (seconds < MONTH) return relative.format(-Math.floor(seconds / WEEK), 'week');
  if (seconds < YEAR) return relative.format(-Math.floor(seconds / MONTH), 'month');
  return relative.format(-Math.floor(seconds / YEAR), 'year');
}

/** The exact date and time, for the `title` of a relative time. */
export function formatExactTime(date: Date): string {
  return exact.format(date);
}
