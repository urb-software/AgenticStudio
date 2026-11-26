import { Inject, Injectable } from '@nestjs/common';
import {
  AGENT_SKILLS,
  type AgentSkills,
  type RunSkillFiles,
} from '../../../../agents/contracts/index.js';
import {
  RunNotFoundError,
  RunNotHeldError,
  SkillsInvalidError,
  SkillsReadFailedError,
  SkillsUnavailableError,
} from '../../../domain/errors/run-errors.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { SkillsRefusal } from '../../../domain/value-objects/skills-refusal.js';

export interface GetRunSkillsInput {
  runId: string;
  workerId: string;
}

export interface GetRunSkillsResult {
  /** The definitions Repository commit the files come from; `null` for a built-in agent. */
  commit: string | null;
  skills: RunSkillFiles[];
  /** Skills left out because those before them used the Run's byte budget. */
  omitted: string[];
}

/**
 * The files of the skills the Run recorded, at the commit it recorded, for the worker that holds
 * the Run; the caller names neither. Throws a `RunNotFoundError`, `RunNotHeldError` or a
 * `Skills…Error`.
 */
@Injectable()
export class GetRunSkillsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(AGENT_SKILLS) private readonly skills: AgentSkills,
  ) {}

  async execute(input: GetRunSkillsInput): Promise<GetRunSkillsResult> {
    const run = isRunId(input.runId) ? await this.runs.findById(input.runId) : null;
    if (!run) throw new RunNotFoundError();
    if (!run.claim.isHeldBy(input.workerId)) throw new RunNotHeldError();
    const { agent } = run;
    if (agent.source === 'built_in' || agent.commit === null) {
      return { commit: null, skills: [], omitted: [] };
    }
    if (agent.skills.length === 0) return { commit: agent.commit, skills: [], omitted: [] };
    const read = await this.skills.files(agent.skills, agent.commit);
    if (read.status === 'unavailable') throw new SkillsUnavailableError();
    if (read.status === 'unreadable') throw new SkillsReadFailedError();
    if (read.status === 'invalid')
      throw new SkillsInvalidError(SkillsRefusal.of(read.problems).detail);
    return { commit: agent.commit, skills: read.skills, omitted: read.omitted };
  }
}
