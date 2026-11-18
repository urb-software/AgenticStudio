import { describe, expect, it } from 'vitest';
import { NormalizedName } from '../normalized-name.js';

describe('NormalizedName', () => {
  it('trims, collapses whitespace runs and keeps the case', () => {
    expect(NormalizedName.of('  Acme   Shop  ').value).toBe('Acme Shop');
  });

  it('writes NFD and NFC spellings alike, and is idempotent', () => {
    const once = NormalizedName.of('Café').value;
    expect(once).toBe('Café');
    expect(NormalizedName.of(once).value).toBe(once);
  });

  it('has no length rule', () => {
    expect(NormalizedName.of('   ').value).toBe('');
    expect(NormalizedName.of('x'.repeat(500)).value).toHaveLength(500);
  });
});
