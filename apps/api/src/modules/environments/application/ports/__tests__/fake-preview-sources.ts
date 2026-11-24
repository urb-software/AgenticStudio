import { vi } from 'vitest';
import type {
  IntegrationFileResult,
  PreviewArchiveResult,
  PreviewSourceStatus,
  RunPreviewSources,
} from '../../../../projects/contracts/index.js';

/** A Compose file the validation accepts, with one published port it removes. */
export const COMPOSE_TEXT = [
  'services:',
  '  web:',
  '    image: nginx:1.27',
  '    ports:',
  '      - "8080:80"',
  '',
].join('\n');

export const COMMIT = 'c'.repeat(40);

/**
 * A scripted {@link RunPreviewSources}: a ready Repository holding {@link COMPOSE_TEXT} unless a
 * test sets another answer.
 */
export class FakePreviewSources implements RunPreviewSources {
  statusAnswer: PreviewSourceStatus = { status: 'ready', commit: COMMIT, fetchedAt: null };
  archiveAnswer: PreviewArchiveResult = { status: 'commit_missing' };
  fileAnswer: IntegrationFileResult = { status: 'found', text: COMPOSE_TEXT, commit: COMMIT };

  status = vi.fn<RunPreviewSources['status']>(() => Promise.resolve(this.statusAnswer));

  readIntegrationFile = vi.fn<RunPreviewSources['readIntegrationFile']>(() =>
    Promise.resolve(this.fileAnswer),
  );

  openArchive = vi.fn<RunPreviewSources['openArchive']>(() => Promise.resolve(this.archiveAnswer));

  /** The names of the projects `projectNames` knows, by id. */
  names = new Map<string, string>();

  projectNames = vi.fn<RunPreviewSources['projectNames']>((ids) =>
    Promise.resolve(
      new Map(ids.flatMap((id) => (this.names.has(id) ? [[id, this.names.get(id)!]] : []))),
    ),
  );
}
