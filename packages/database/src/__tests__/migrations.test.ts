import { describe, expect, it } from 'vitest';
import { committedMigrations } from '../migrations.js';

// Prisma applies migrations in folder-name order, so a shared timestamp prefix makes the order
// depend on the rest of the name. Applied migrations are never renamed: the one pair sharing a
// prefix (independent tables) is allowed by name.
const ALLOWED_SHARED_PREFIXES: Record<string, readonly string[]> = {
  '20261115500000': ['20261115500000_environment_files', '20261115500000_run_cancellation_limits'],
};

/** Migration folders by their 14-digit timestamp prefix, for prefixes used more than once. */
function sharedPrefixes(names: readonly string[]): Record<string, string[]> {
  const byPrefix: Record<string, string[]> = {};
  for (const name of names) {
    const prefix = /^(\d{14})_/.exec(name)?.[1] ?? name;
    (byPrefix[prefix] ??= []).push(name);
  }
  return Object.fromEntries(Object.entries(byPrefix).filter(([, list]) => list.length > 1));
}

describe('committed migrations', () => {
  it('each start with a 14-digit timestamp and a name', async () => {
    for (const name of await committedMigrations()) {
      expect(name).toMatch(/^\d{14}_[a-z0-9_]+$/);
    }
  });

  it('never share a timestamp prefix, except the allowed applied pair', async () => {
    expect(sharedPrefixes(await committedMigrations())).toEqual(ALLOWED_SHARED_PREFIXES);
  });

  it('would catch a new migration on a timestamp already taken', () => {
    expect(
      sharedPrefixes([
        '20261115800000_run_questions',
        '20261115800000_another_change',
        '20261116000000_later',
      ]),
    ).toEqual({
      '20261115800000': ['20261115800000_run_questions', '20261115800000_another_change'],
    });
  });
});
