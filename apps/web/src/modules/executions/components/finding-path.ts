/**
 * Whether a file a review finding names is a relative path inside the Working copy, so the page
 * may lead to it on the Changes tab. A reviewer's text is untrusted: an absolute path, a path with
 * `..` or a backslash, a drive, a home directory or an address is shown as text and never used.
 */
export function isWorkingCopyPath(path: string): boolean {
  if (path === '' || path.length > 512) return false;
  if (path.startsWith('/') || path.startsWith('~') || path.includes('\\')) return false;
  // A drive letter (`C:`) or a scheme (`file:`): anything with a colon before the first slash.
  const firstSegment = path.split('/')[0]!;
  if (firstSegment.includes(':')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
