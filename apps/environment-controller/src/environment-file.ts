import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { OperationFailure } from './failure.js';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function segmentsOf(path: string): string[] {
  const segments = path.split('/');
  if (
    path === '' ||
    path.length > 255 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    segments.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new OperationFailure('controller_error', 'The Environment file path is not valid.');
  }
  return segments;
}

const tracked = () =>
  new OperationFailure(
    'environment_file_tracked',
    'The Environment file path is already a tracked path of the source.',
  );

/**
 * Writes the Project's Environment file into the unpacked source at its path, mode 0600. The
 * parents must be real directories (made when missing) and the file must not exist: a tracked
 * file or symlink there is refused, so the controller never overwrites source.
 */
export async function writeEnvironmentFile(
  srcDir: string,
  path: string,
  content: string,
): Promise<void> {
  const segments = segmentsOf(path);
  let current = srcDir;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing === null) await mkdir(current, { mode: 0o755 });
    else if (!existing.isDirectory()) throw tracked();
  }
  let handle;
  try {
    handle = await open(
      join(srcDir, ...segments),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ELOOP' || code === 'EISDIR') throw tracked();
    throw error;
  }
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}
