import { describe, expect, it } from 'vitest';
import { formatAge } from '../../lib/queries';

describe('formatAge', () => {
  it('returns a human-readable relative time', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatAge(fiveMinutesAgo)).toBe('5m ago');
  });

  it('returns an em dash for null input', () => {
    expect(formatAge(null)).toBe('—');
  });
});
