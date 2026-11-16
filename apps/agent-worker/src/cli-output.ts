/** Helpers for a provider CLI's own output (Issues #105, #106). */

/** Longest CLI reason taken into a failure detail. */
const REASON_MAX = 500;

/** "Its error output: <last line of standard error>", cut to {@link REASON_MAX} characters. */
export function errorReason(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? '';
  const reason = last.length > REASON_MAX ? `${last.slice(0, REASON_MAX - 1)}…` : last;
  return `Its error output: ${reason}`;
}
