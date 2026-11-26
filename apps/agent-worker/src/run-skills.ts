import {
  RUN_SKILLS_MAX_BYTES,
  type RunPayload,
  type RunSkillsResponse,
  WORKER_PROBLEM_TYPES,
} from '@agentic-studio/contracts';
import { SKILL_ENTRY_FILE, validateSkillFolder } from '@agentic-studio/agent-definitions';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DIRECTORY_MODE, type PlacedFile, writeFiles } from './placed-files.js';
import { isRunLost, StudioApiError } from './studio-api.js';

/** The hand-over route as the worker uses it ({@link StudioApi} in production). */
export interface RunSkillsApi {
  runSkills(runId: string, signal?: AbortSignal): Promise<RunSkillsResponse>;
}

/**
 * The Run's skills cannot be used: Studio cannot hand them over, they are gone, or they fail the
 * validation. The Run fails `skills_unusable` with `detail`, which names skills, paths and codes
 * only, before any agent starts.
 */
export class SkillsUnusableError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'SkillsUnusableError';
  }
}

/** One skill as the agent is told about it: the entry file is an absolute path. */
export interface PlacedSkill {
  name: string;
  description: string;
  entryFile: string;
}

export interface PlacedSkills {
  /** Absolute path of the folder in the Run's directory; it holds `<name>/` per placed skill. */
  dir: string;
  /** In the order the Run lists them. */
  skills: PlacedSkill[];
  /** Skills Studio left out because those before them used the Run's byte budget. */
  omitted: string[];
}

type Wanted = NonNullable<RunPayload['skills']>;
type RunSkillsRun = Pick<RunPayload, 'runId' | 'agent' | 'skills'>;

interface HandedSkill {
  name: string;
  description: string;
  files: PlacedFile[];
}

/**
 * The Run's skills in its directory: fetched by the Run's id, judged by the shared validation
 * again, written fresh before every step. It starts no process, runs nothing and keeps no copy
 * where the agent user can write.
 */
export class RunSkills {
  constructor(private readonly options: { api: RunSkillsApi }) {}

  /**
   * Rebuilds `dir` for the Run's skills. Nothing is written, and an earlier folder stays, when the
   * hand-over is refused. `null` (and no folder) for a Run without skills.
   */
  async place(run: RunSkillsRun, dir: string, signal: AbortSignal): Promise<PlacedSkills | null> {
    const wanted = wantedOf(run);
    if (wanted === null) {
      // A link at `dir` is removed itself, never followed.
      await rm(dir, { recursive: true, force: true });
      return null;
    }
    const { handed, omitted } = await this.fetch(run, wanted, signal);
    await rm(dir, { recursive: true, force: true });
    if (handed.length === 0) return { dir, skills: [], omitted };
    try {
      await mkdir(dir, { mode: DIRECTORY_MODE });
      await chmod(dir, DIRECTORY_MODE);
      for (const skill of handed) {
        await writeFiles(
          join(dir, skill.name),
          skill.files,
          () => new SkillsUnusableError('A path of the hand-over leaves its skill folder.'),
        );
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return {
      dir,
      skills: handed.map(({ name, description }) => ({
        name,
        description,
        entryFile: join(dir, name, SKILL_ENTRY_FILE),
      })),
      omitted,
    };
  }

  /**
   * The Git blob ids (SHA-1 and SHA-256) of the skills' non-empty files, each with its path as
   * `skills/<name>/<path>`: what must never appear in a commit of the Run branch. Fetched afresh,
   * written nowhere.
   */
  async placedBlobs(run: RunSkillsRun, signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
    const blobs = new Map<string, string>();
    const wanted = wantedOf(run);
    if (wanted === null) return blobs;
    for (const skill of (await this.fetch(run, wanted, signal)).handed) {
      for (const file of skill.files) {
        if (file.content.length === 0) continue;
        for (const algorithm of ['sha1', 'sha256'] as const) {
          const id = createHash(algorithm)
            .update(`blob ${file.content.length}\0`)
            .update(file.content)
            .digest('hex');
          blobs.set(id, `skills/${skill.name}/${file.path}`);
        }
      }
    }
    return blobs;
  }

  private async fetch(
    run: RunSkillsRun,
    wanted: Wanted,
    signal: AbortSignal,
  ): Promise<{ handed: HandedSkill[]; omitted: string[] }> {
    let answer: RunSkillsResponse;
    try {
      answer = await this.options.api.runSkills(run.runId, signal);
    } catch (error) {
      throw refusal(error, signal);
    }
    if (answer.commit !== run.agent.commit) {
      throw new SkillsUnusableError('The hand-over names another commit than the Run recorded.');
    }
    const listed = [...answer.skills.map((skill) => skill.name), ...answer.omitted];
    if (listed.join('\n') !== wanted.map((skill) => skill.name).join('\n')) {
      throw new SkillsUnusableError('The hand-over does not hold the skills the Run recorded.');
    }
    return { handed: judge(answer, wanted), omitted: answer.omitted };
  }
}

/** The claim's skills, or `null` when the Run has none to place (a built-in agent included). */
function wantedOf(run: RunSkillsRun): Wanted | null {
  if (run.agent.source === 'built_in' || run.agent.commit === null) return null;
  return run.skills !== undefined && run.skills.length > 0 ? run.skills : null;
}

/** What the Run fails with when the route did not answer: the stop of the caller is kept. */
function refusal(error: unknown, signal: AbortSignal): unknown {
  // A stop is the caller's, and a lost Run is the worker's own loss handling, never a failure here.
  if (signal.aborted || isRunLost(error)) return error;
  if (error instanceof StudioApiError && error.status === 409) {
    if (error.problemType === WORKER_PROBLEM_TYPES.skillsUnavailable) {
      return new SkillsUnusableError(
        "The agent's skills are no longer available in the definitions Repository at the commit this run recorded. Start a new run.",
      );
    }
    if (error.problemType === WORKER_PROBLEM_TYPES.skillsInvalid) {
      return new SkillsUnusableError("Studio refused the agent's skills as invalid.");
    }
  }
  // An answer that fails the protocol's schema is a bad hand-over, not an outage.
  if (error instanceof z.ZodError) {
    return new SkillsUnusableError("Studio's hand-over of the agent's skills is malformed.");
  }
  return new SkillsUnusableError(
    "The agent's skills could not be fetched from Studio right now. Start the run again to try again.",
  );
}

/** Decodes and judges a hand-over; throws before anything is written. */
function judge(answer: RunSkillsResponse, wanted: Wanted): HandedSkill[] {
  const descriptions = new Map(wanted.map((skill) => [skill.name, skill.description]));
  let total = 0;
  const handed: HandedSkill[] = [];
  for (const skill of answer.skills) {
    const files: PlacedFile[] = [];
    for (const item of skill.files) {
      const content = Buffer.from(item.contentBase64, 'base64');
      if (content.toString('base64') !== item.contentBase64) {
        throw new SkillsUnusableError(
          `A file of the skill ${skill.name} is not canonical base64 in the hand-over.`,
        );
      }
      total += content.length;
      files.push({ path: item.path, executable: item.executable, content });
    }
    if (total > RUN_SKILLS_MAX_BYTES) {
      throw new SkillsUnusableError(
        'The hand-over is larger than the total budget of skill files for one Run.',
      );
    }
    // Markdown is read for shell lines; the entry file for its front matter. The rest is size only.
    const judged = validateSkillFolder(
      skill.name,
      files.map((file) => ({
        path: file.path,
        kind: 'file',
        size: file.content.length,
        ...(/\.(md|markdown)$/i.test(file.path) ? { content: file.content.toString('utf8') } : {}),
      })),
    );
    if (!judged.ok) {
      const listed = judged.problems
        .slice(0, 10)
        .map((item) => `${item.code} (${skill.name}${item.path === '' ? '' : `/${item.path}`})`);
      throw new SkillsUnusableError(
        `The skill ${skill.name} fails the validation: ${listed.join(', ')}.`,
      );
    }
    if (judged.definition.description !== descriptions.get(skill.name)) {
      throw new SkillsUnusableError(
        `The description of the skill ${skill.name} differs from the one the Run recorded.`,
      );
    }
    handed.push({ name: skill.name, description: judged.definition.description, files });
  }
  return handed;
}

/**
 * The Run log's lines about a step's skills: the names placed, and the names left out for the byte
 * budget. Never a description, a path or any content.
 */
export function skillsNotices(placed: PlacedSkills): string[] {
  const notices: string[] = [];
  if (placed.skills.length > 0) {
    notices.push(`Skills: ${placed.skills.map((skill) => skill.name).join(', ')}`);
  }
  if (placed.omitted.length > 0) {
    notices.push(
      `Skills left out because their files pass ${RUN_SKILLS_MAX_BYTES / (1024 * 1024)} MiB in total: ${placed.omitted.join(', ')}`,
    );
  }
  return notices;
}
