/**
 * Daily "customer order expected today" reminder: time helpers + a small in-process scheduler.
 *
 * No cron dependency. The scheduler wakes at most every WAKE_MAX_MS and runs the job when the shop's local time
 * (Africa/Tunis) is at or past 08:00 and the job has not completed for today's local date yet. Because it re-checks
 * the wall clock on every wake-up, it also survives clock drift and a host that was suspended for a while.
 *
 * Duplicates are prevented by the job itself, not by the scheduler: each order records the expected date it was
 * reminded for (`orders.sendDueReminders` claims it in a transaction). So running the job twice, on two
 * instances, or again after a restart is always safe.
 */
export const REMINDER_TIMEZONE = 'Africa/Tunis';
export const REMINDER_HOUR = 8;
const WAKE_MAX_MS = 10 * 60_000;
const MAX_ATTEMPTS_PER_DAY = 6; // while some reminders could not be delivered (no device, FCM down)

const formatters = new Map();
function zoned(ms, timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  const p = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return p;
}

const pad = (n) => String(n).padStart(2, '0');

/** The shop's calendar date `yyyy-MM-dd` at this instant (same shape as an order's `expectedDate`). */
export function businessDateAt(ms, timeZone = REMINDER_TIMEZONE) {
  const p = zoned(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Is the local clock at or past the reminder hour? */
export function isPastReminderTime(ms, { timeZone = REMINDER_TIMEZONE, hour = REMINDER_HOUR } = {}) {
  return zoned(ms, timeZone).hour >= hour;
}

/** UTC offset (ms) of `timeZone` at instant `ms`. */
function offsetAt(ms, timeZone) {
  const p = zoned(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the local wall clock of `timeZone` reads y-m-d hour:00 (two passes handle DST changes). */
function wallToInstant(y, m, d, hour, timeZone) {
  const guess = Date.UTC(y, m - 1, d, hour);
  return guess - offsetAt(guess - offsetAt(guess, timeZone), timeZone);
}

/** The next local `hour`:00 strictly after `ms`. */
export function nextRunAfter(ms, { timeZone = REMINDER_TIMEZONE, hour = REMINDER_HOUR } = {}) {
  const p = zoned(ms, timeZone);
  const today = wallToInstant(p.year, p.month, p.day, hour, timeZone);
  if (today > ms) return today;
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return wallToInstant(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), hour, timeZone);
}

/**
 * Starts the daily scheduler. `run()` is the job; it resolves to `{ undelivered }` (reminders it could not
 * deliver and released for a retry). A throw counts as a failed attempt. Returns `{ stop }`.
 * `setTimer` / `clearTimer` are injectable for tests.
 */
export function startDailyReminders({
  run, logger, now = () => Date.now(),
  timeZone = REMINDER_TIMEZONE, hour = REMINDER_HOUR,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let timer = null;
  let stopped = false;
  let running = false;
  let doneFor = null; // local date the job has completed for (in memory; the per-order claim is the real guard)
  let attempts = { date: null, n: 0 };

  async function attempt(reason) {
    const today = businessDateAt(now(), timeZone);
    if (doneFor === today || running) return;
    if (attempts.date !== today) attempts = { date: today, n: 0 };
    attempts.n += 1;
    running = true;
    try {
      const r = (await run()) ?? {};
      logger?.info({ reason, attempt: attempts.n, ...r }, 'expected-date reminders ran');
      if (!r.undelivered || attempts.n >= MAX_ATTEMPTS_PER_DAY) doneFor = today;
    } catch (err) {
      logger?.error({ err, reason, attempt: attempts.n }, 'expected-date reminders failed');
      if (attempts.n >= MAX_ATTEMPTS_PER_DAY) doneFor = today;
    } finally {
      running = false;
    }
  }

  function arm() {
    if (stopped) return;
    const delay = Math.min(Math.max(nextRunAfter(now(), { timeZone, hour }) - now(), 1000), WAKE_MAX_MS);
    timer = setTimer(async () => {
      if (isPastReminderTime(now(), { timeZone, hour })) await attempt('scheduled');
      arm();
    }, delay);
    timer?.unref?.();
  }

  // After a restart (or a deploy) later than 08:00 the reminders are still owed for today: catch up right away.
  if (isPastReminderTime(now(), { timeZone, hour })) void attempt('startup catch-up');
  arm();

  return { stop() { stopped = true; if (timer) clearTimer(timer); timer = null; } };
}
