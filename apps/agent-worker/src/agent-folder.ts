import {
  type AgentFolderResponse,
  type RunPayload,
  WORKER_PROBLEM_TYPES,
} from '@agentic-studio/contracts';
import { AGENT_ENTRY_FILE, validateAgentFiles } from '@agentic-studio/agent-definitions';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { rm } from 'node:fs/promises';
import { type PlacedFile, writeFiles } from './placed-files.js';
import { isTransient, StudioApiError } from './studio-api.js';

/** The hand-over route as the worker uses it ({@link StudioApi} in production). */
export interface AgentFolderApi {
  agentFolder(runId: string, signal?: AbortSignal): Promise<AgentFolderResponse>;
}

/** Studio no longer has the agent's files; the Run fails `agent_folder_unavailable`. */
export class AgentFolderUnavailableError extends Error {
  constructor(detail = "The agent's files are no longer available in the definitions Repository.") {
    super(detail);
    this.name = 'AgentFolderUnavailableError';
  }
}

/** Studio could not read the files now (a failed read, an outage); the Run fails `preparation_failed`. */
export class AgentFolderTransientError extends Error {
  constructor() {
    super(
      "The agent's files could not be fetched from Studio right now. Start the run again to try again.",
    );
    this.name = 'AgentFolderTransientError';
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

type HandedFile = PlacedFile;

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
      await writeFiles(
        dir,
        files,
        () => new AgentFolderInvalidError('A path of the hand-over leaves the agent folder.'),
      );
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
      // A stop is the caller's, never a failure of the hand-over.
      if (signal.aborted) throw error;
      if (error instanceof StudioApiError && error.status === 409) {
        if (error.problemType === WORKER_PROBLEM_TYPES.agentFolderUnavailable) {
          throw new AgentFolderUnavailableError();
        }
        if (error.problemType === WORKER_PROBLEM_TYPES.agentFolderInvalid) {
          throw new AgentFolderInvalidError("Studio refused the agent's files as invalid.");
        }
        if (error.problemType === WORKER_PROBLEM_TYPES.agentFolderCut) {
          throw new AgentFolderUnavailableError(
            "The definitions Repository has too many files to read this agent's folder safely.",
          );
        }
      }
      // An answer that fails the protocol's schema is a bad hand-over, not an outage.
      if (error instanceof z.ZodError) {
        throw new AgentFolderInvalidError("Studio's hand-over of the agent's files is malformed.");
      }
      if (isTransient(error)) throw new AgentFolderTransientError();
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
