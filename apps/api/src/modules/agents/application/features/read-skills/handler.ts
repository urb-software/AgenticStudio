import { Injectable } from '@nestjs/common';
import { AgentsReader } from '../../agents-reader.js';
import { type SkillsRead, SkillsReader } from '../../skills-reader.js';

export {
  MAX_LISTED_SKILLS,
  MAX_ON_DEMAND_SKILLS,
  MAX_READ_BYTES,
  MAX_READ_PATHS,
} from '../../skills-reader.js';
export type { SkillView } from '../../skills-reader.js';

export interface ReadSkillsInput {
  /** Reads this skill only, wherever it sits among the folders. */
  name?: string;
}

export interface ReadSkillsResult extends SkillsRead {
  /** With a `name`: the agents at the same commit whose definition lists it; empty otherwise. */
  usedBy: string[];
}

/** The skills list and the single skill, with the agents that name the skill read. */
@Injectable()
export class ReadSkillsHandler {
  constructor(
    private readonly skills: SkillsReader,
    private readonly agents: AgentsReader,
  ) {}

  async execute(input: ReadSkillsInput = {}): Promise<ReadSkillsResult> {
    const result = await this.skills.read(input);
    const usedBy =
      input.name === undefined || result.commit === null || result.skills.length === 0
        ? []
        : await this.agents.skillUsers(result.commit, input.name);
    return { ...result, usedBy };
  }
}
