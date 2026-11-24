import { PREVIEW_COMPOSE_PROJECT_PATTERN, PREVIEW_LABEL_PATTERN } from '@agentic-studio/contracts';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { desiredStateFile, previewRoot } from './layout.js';

const desiredSchema = z.strictObject({
  projectId: z.uuid(),
  /** The build whose directory holds what `up --no-build` needs. */
  operationId: z.uuid(),
  composeProject: z.string().regex(PREVIEW_COMPOSE_PROJECT_PATTERN),
  previewLabel: z.string().regex(PREVIEW_LABEL_PATTERN),
  service: z.string().min(1).max(63),
  port: z.number().int().min(1).max(65_535),
  /** Where the build's own copy of the Environment file is in its source tree, if any. */
  environmentFilePath: z.string().min(1).max(255).nullable(),
});
export type DesiredPreview = z.infer<typeof desiredSchema>;

/**
 * The Previews that should be running, one small file each in the Project's own directory. After
 * a daemon restart (`restart: "no"`) the controller starts them again from these.
 */
export class DesiredStates {
  constructor(private readonly dataDir: string) {}

  async record(desired: DesiredPreview): Promise<void> {
    const file = desiredStateFile(this.dataDir, desired.projectId);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(desired), { mode: 0o600 });
    await rename(temporary, file);
  }

  async clear(projectId: string): Promise<void> {
    await rm(desiredStateFile(this.dataDir, projectId), { force: true });
  }

  /** Every readable desired state; an unreadable or invalid file is skipped. */
  async list(): Promise<DesiredPreview[]> {
    const previews = join(this.dataDir, 'previews');
    const projects = await readdir(previews).catch(() => [] as string[]);
    const found: DesiredPreview[] = [];
    for (const project of projects) {
      try {
        const text = await readFile(
          join(previewRoot(this.dataDir, project), 'desired.json'),
          'utf8',
        );
        const parsed = desiredSchema.safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.projectId === project) found.push(parsed.data);
      } catch {
        // Not a Project directory, or no desired state.
      }
    }
    return found;
  }
}
