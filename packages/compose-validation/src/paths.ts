export type PathVerdict = 'inside' | 'outside';

/**
 * Judges a path lexically against the source directory, written as `.`. It reads no file system,
 * so a symlink inside the source cannot be seen here: whoever extracts the source must refuse
 * symlinks that leave it.
 */
export function judgePath(raw: string): PathVerdict {
  // A colon also covers URLs, `git@host:repo` build contexts, `service:name` and drive letters.
  if (raw === '' || raw.includes('\0') || raw.includes(':')) return 'outside';
  const path = raw.replaceAll('\\', '/');
  if (path.startsWith('/') || path.startsWith('~')) return 'outside';
  // Compose reads this form of a build context as a remote Git repository.
  if (path.startsWith('github.com/')) return 'outside';
  let depth = 0;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return 'outside';
    } else {
      depth += 1;
    }
  }
  return 'inside';
}

/** Joins a path to a base (a Dockerfile to its build context) before judging it. */
export function judgeJoined(base: string, relative: string): PathVerdict {
  if (judgePath(base) === 'outside' || judgePath(relative) === 'outside') return 'outside';
  return judgePath(`${base.replaceAll('\\', '/')}/${relative}`);
}

export function isDockerSocketPath(raw: string): boolean {
  return raw.toLowerCase().includes('docker.sock');
}
