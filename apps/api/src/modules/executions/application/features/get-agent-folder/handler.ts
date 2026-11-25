import { Inject, Injectable } from '@nestjs/common';
import { AGENT_FOLDERS, type AgentFolders } from '../../../../agents/contracts/index.js';
import {
  AgentFolderInvalidError,
  AgentFolderUnavailableError,
  RunNotFoundError,
  RunNotHeldError,
} from '../../../domain/errors/run-errors.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';

export interface GetAgentFolderInput {
  runId: string;
  workerId: string;
}

export interface GetAgentFolderResult {
  /** The definitions Repository commit the files come from; `null` for a built-in agent. */
  commit: string | null;
  files: { path: string; executable: boolean; content: Uint8Array }[];
}

/**
 * The files of the Run's recorded agent at its recorded commit, for the worker that holds the Run.
 * The caller names neither agent nor commit. Throws {@link RunNotFoundError},
 * {@link RunNotHeldError}, {@link AgentFolderUnavailableError} or {@link AgentFolderInvalidError}.
 */
@Injectable()
export class GetAgentFolderHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(AGENT_FOLDERS) private readonly folders: AgentFolders,
  ) {}

  async execute(input: GetAgentFolderInput): Promise<GetAgentFolderResult> {
    const run = isRunId(input.runId) ? await this.runs.findById(input.runId) : null;
    if (!run) throw new RunNotFoundError();
    if (!run.claim.isHeldBy(input.workerId)) throw new RunNotHeldError();
    const { agent } = run;
    if (agent.source === 'built_in' || agent.commit === null) return { commit: null, files: [] };
    const folder = await this.folders.folderAt(agent.name, agent.commit);
    if (folder.status === 'unavailable') throw new AgentFolderUnavailableError();
    if (folder.status === 'invalid') {
      const listed = folder.problems.map((item) => `${item.code} (${item.path || 'folder'})`);
      throw new AgentFolderInvalidError(
        `The agent's files fail the validation: ${listed.slice(0, 10).join(', ')}.`,
      );
    }
    return { commit: agent.commit, files: folder.files };
  }
}
