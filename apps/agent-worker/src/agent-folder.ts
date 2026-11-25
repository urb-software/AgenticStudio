import {
  type AgentFolderResponse,
  type RunPayload,
  WORKER_PROBLEM_TYPES,
} from '@agentic-studio/contracts';
import { AGENT_ENTRY_FILE, validateAgentFiles } from '@agentic-studio/agent-definitions';
import { createHash } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { StudioApiError } from './studio-api.js';

/** The hand-over route as the worker uses it ({@link StudioApi} in production). */
export interface AgentFolderApi {
  agentFolder(runId: string, signal?: AbortSignal): Promise<AgentFolderResponse>;
}

/** Studio no longer has the agent's files; the Run fails `agent_folder_unavailable`. */
export class AgentFolderUnavailableError extends Error {
  constructor() {
    super("The agent's files are no longer available in the definitions Repository.");
    this.name = 'AgentFolderUnavailableError';
  }
}

/** The hand-over fails the validation; the Run fails `agent_folder_invalid`. `detail` names paths and codes. */
export class AgentFolderInvalidError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'AgentFolderInvalidError';
  }
}

export interface PlacedAgentFolder {
  /** Absolute path of the folder in the Run's directory. */
  dir: string;
  files: number;
}

/** What the agent gets: Git's executable bit is the only mode that comes from the Repository. */
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
const DIRECTORY_MODE = 0o755;

interface HandedFile {
  path: string;
  executable: boolean;
  content: Buffer;
}

/**
 * The agent's folder in the Run's directory: fetched from Studio, judged by the shared validation
 * again, written fresh before every step. It starts no process and runs, sources or changes the
 * mode of nothing beyond the modes above; nothing is kept anywhere the agent user can write.
 */
export class AgentFolders {
  constructor(private readonly options: { api: AgentFolderApi }) {}

  /**
   * Rebuilds `dir` for the Run's agent. Nothing is written, and an earlier folder stays, when the
   * hand-over is refused. `null` (and no folder) for an agent without files, a built-in one included.
   */
  async place(
    run: Pick<RunPayload, 'runId' | 'agent'>,
    dir: string,
    signal: AbortSignal,
  ): Promise<PlacedAgentFolder | null> {
    const files = await this.fetch(run, signal);
    // A link at `dir` is removed itself, never followed.
    await rm(dir, { recursive: true, force: true });
    if (files.length === 0) return null;
    try {
      await write(dir, files);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return { dir, files: files.length };
  }

  /**
   * The Git blob ids (SHA-1 and SHA-256) of the folder's non-empty files, each with its path in the
   * folder: what must never appear in a commit of the Run branch. Fetched afresh, written nowhere.
   */
  async placedBlobs(
    run: Pick<RunPayload, 'runId' | 'agent'>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    const blobs = new Map<string, string>();
    for (const file of await this.fetch(run, signal)) {
      if (file.content.length === 0) continue;
      for (const algorithm of ['sha1', 'sha256'] as const) {
        const id = createHash(algorithm)
          .update(`blob ${file.content.length}\0`)
          .update(file.content)
          .digest('hex');
        blobs.set(id, file.path);
      }
    }
    return blobs;
  }

  private async fetch(
    run: Pick<RunPayload, 'runId' | 'agent'>,
    signal: AbortSignal,
  ): Promise<HandedFile[]> {
    const { agent } = run;
    if (agent.source === 'built_in' || agent.commit === null) return [];
    let handed: AgentFolderResponse;
    try {
      handed = await this.options.api.agentFolder(run.runId, signal);
    } catch (error) {
      if (error instanceof StudioApiError && error.status === 409) {
        if (error.problemType === WORKER_PROBLEM_TYPES.agentFolderUnavailable) {
          throw new AgentFolderUnavailableError();
        }
        if (error.problemType === WORKER_PROBLEM_TYPES.agentFolderInvalid) {
          throw new AgentFolderInvalidError("Studio refused the agent's files as invalid.");
        }
      }
      throw error;
    }
    if (handed.commit !== agent.commit) {
      throw new AgentFolderInvalidError(
        'The hand-over names another commit than the Run recorded.',
      );
    }
    return judge(handed);
  }
}

/** Decodes and judges a hand-over; throws before anything is written. */
function judge(handed: AgentFolderResponse): HandedFile[] {
  const files: HandedFile[] = [];
  for (const item of handed.files) {
    const content = Buffer.from(item.contentBase64, 'base64');
    if (content.toString('base64') !== item.contentBase64) {
      throw new AgentFolderInvalidError('A file of the hand-over is not canonical base64.');
    }
    files.push({ path: item.path, executable: item.executable, content });
  }
  const problems = validateAgentFiles(
    files.map((file) => ({ path: file.path, kind: 'file', size: file.content.length })),
  );
  // The entry file never reaches a CLI: its instructions travel in the claim.
  if (files.some((file) => file.path.toLowerCase() === AGENT_ENTRY_FILE.toLowerCase())) {
    throw new AgentFolderInvalidError(
      'The hand-over holds the entry file, which is never handed over.',
    );
  }
  if (problems.length > 0) {
    const listed = problems.slice(0, 10).map((item) => `${item.code} (${item.path || 'folder'})`);
    throw new AgentFolderInvalidError(
      `The agent's files fail the validation: ${listed.join(', ')}.`,
    );
  }
  return files;
}

/** Writes the files below `dir`; each path is joined safely and must stay inside it. */
async function write(dir: string, files: HandedFile[]): Promise<void> {
  const root = resolve(dir);
  await mkdir(root, { mode: DIRECTORY_MODE });
  await chmod(root, DIRECTORY_MODE);
  const made = new Set<string>([root]);
  for (const file of files) {
    const target = resolve(root, ...file.path.split('/'));
    const inside = relative(root, target);
    if (inside === '' || inside.startsWith('..') || !target.startsWith(`${root}${sep}`)) {
      throw new AgentFolderInvalidError('A path of the hand-over leaves the agent folder.');
    }
    const parents: string[] = [];
    for (let parent = dirname(target); !made.has(parent); parent = dirname(parent)) {
      parents.unshift(parent);
    }
    for (const parent of parents) {
      await mkdir(parent, { mode: DIRECTORY_MODE });
      await chmod(parent, DIRECTORY_MODE);
      made.add(parent);
    }
    const mode = file.executable ? EXECUTABLE_MODE : FILE_MODE;
    // `wx`: never through a link, never over an existing file.
    await writeFile(join(target), file.content, { flag: 'wx', mode });
    await chmod(target, mode);
  }
}
