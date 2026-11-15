import { describe, expect, it } from 'vitest';
import { REDACTED, redactLogText } from '../log-redaction.js';

// Issue #99: redaction happens before a Run event is stored. Best effort: known secret values
// of the Run, token-shaped strings and credential-bearing URLs become `••••••[redacted]`.
// Token-shaped fixtures are assembled at runtime so no literal looks like a committed secret.
const repeat = (alphabet: string, length: number) =>
  Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join('');
const ALNUM = 'aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z';

describe('redactLogText', () => {
  it('uses the agreed replacement', () => {
    expect(REDACTED).toBe('••••••[redacted]');
  });

  it('leaves ordinary output alone', () => {
    const text = 'pnpm test\n  ✓ 12 tests passed (340 ms)\nhttps://github.com/acme/shop/pull/7';
    expect(redactLogText(text, [])).toBe(text);
  });

  it('replaces every occurrence of a known secret value of the Run', () => {
    expect(redactLogText('DB=hunter2-test; again hunter2-test.', ['hunter2-test'])).toBe(
      `DB=${REDACTED}; again ${REDACTED}.`,
    );
  });

  it('ignores known values too short to redact without wrecking the log', () => {
    expect(redactLogText('a b c 123', ['', 'a', '123'])).toBe('a b c 123');
  });

  it('prefers the longest known value when values overlap', () => {
    expect(redactLogText('key=abcdef123', ['abcd', 'abcdef123'])).toBe(`key=${REDACTED}`);
  });

  it('masks the userinfo of a credential-bearing URL, at any length', () => {
    expect(redactLogText('git clone https://x-access:p@ss/w:rd@github.com/a/b.git done', [])).toBe(
      `git clone https://${REDACTED}@github.com/a/b.git done`,
    );
    expect(redactLogText('postgres://user:pw@db:5432/app', [])).toBe(
      `postgres://${REDACTED}@db:5432/app`,
    );
  });

  it('masks Authorization and Bearer values', () => {
    expect(redactLogText('curl -H "Authorization: token abc.def-123" x', [])).toBe(
      `curl -H "Authorization: ${REDACTED}" x`,
    );
    expect(redactLogText('Authorization: Bearer abc.def', [])).toBe(`Authorization: ${REDACTED}`);
    expect(redactLogText('sent bearer abc.def~ok', [])).toBe(`sent bearer ${REDACTED}`);
  });

  it.each([
    ['a GitHub token', `ghp_${repeat(ALNUM, 36)}`],
    ['a GitHub server token', `ghs_${repeat(ALNUM, 36)}`],
    ['a fine-grained GitHub token', `github_pat_${repeat(ALNUM, 22)}_${repeat(ALNUM, 59)}`],
    ['an sk- API key', `sk-${repeat(ALNUM, 40)}`],
    ['an sk-ant- API key', `sk-ant-api03-${repeat(ALNUM, 80)}-AA`],
    ['an AWS access key id', `AKIA${repeat('ABCDEFGHIJKLMNOP234567', 16)}`],
    ['a JWT', `eyJ${repeat(ALNUM, 20)}.eyJ${repeat(ALNUM, 30)}.${repeat(ALNUM, 43)}`],
  ])('replaces %s', (_case, token) => {
    expect(redactLogText(`token: "${token}" end`, [])).toBe(`token: "${REDACTED}" end`);
    expect(redactLogText(token, [])).toBe(REDACTED);
  });

  it('replaces a private key block, also one cut off before its end line', () => {
    const begin = '-----BEGIN OPENSSH PRIVATE KEY-----';
    const end = '-----END OPENSSH PRIVATE KEY-----';
    expect(redactLogText(`key:\n${begin}\nb3BlbnNzaC1r\nZXktdjEAAAA\n${end}\nnext`, [])).toBe(
      `key:\n${REDACTED}\nnext`,
    );
    expect(redactLogText(`key:\n${begin}\nb3BlbnNzaC1r`, [])).toBe(`key:\n${REDACTED}`);
  });

  it('does not take quadratic time on long hostile input', () => {
    const hostile = `${'https://'.repeat(20_000)}${'eyJa.'.repeat(20_000)}${'sk-'.repeat(20_000)}`;
    const started = performance.now();
    redactLogText(hostile, ['abcd']);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
