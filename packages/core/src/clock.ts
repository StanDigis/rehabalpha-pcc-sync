/**
 * Time is injected rather than read from `Date.now()` directly. Two reasons that both bit
 * us conceptually while designing the coverage timeline: bitemporal records need a single
 * consistent "now" for an entire transaction, and tests that assert on effective-date
 * arithmetic are unreadable when the clock moves underneath them.
 */
export type Clock = {
  now(): string;
};

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

export function fixedClock(instant: string): Clock {
  const normalised = new Date(instant).toISOString();
  return { now: () => normalised };
}

/**
 * The calendar date at an instant, in a facility's own time zone.
 *
 * Coverage effective dates, admit dates and discharge dates are calendar dates in the facility's
 * local reckoning, not UTC instants. Using UTC to decide "today" ends a New York patient's
 * coverage a day early for every event after 8pm local, which is precisely when the evening
 * admissions happen. The bug is invisible in a test suite that runs in UTC and obvious to a
 * biller the following morning.
 */
export function localCalendarDate(instant: string, timeZone: string): string {
  // The en-CA locale formats as YYYY-MM-DD, which avoids assembling the parts by hand.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

/** Advances by a fixed step on each read, for asserting on ordering of generated records. */
export function tickingClock(start: string, stepMs = 1000): Clock {
  let current = new Date(start).getTime();
  return {
    now: () => {
      const value = new Date(current).toISOString();
      current += stepMs;
      return value;
    },
  };
}
