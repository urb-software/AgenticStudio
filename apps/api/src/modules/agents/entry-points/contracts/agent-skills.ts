import { Injectable } from '@nestjs/common';
import { ReadRunSkillsHandler } from '../../application/features/read-run-skills/handler.js';
import type {
  AgentSkills,
  RunSkillDescriptionsRead,
  RunSkillFilesRead,
} from '../../contracts/index.js';

/** The driving adapter of {@link AgentSkills}: it maps each call to the handler and holds no rule. */
@Injectable()
export class ReadRunSkillsAgentSkills implements AgentSkills {
  constructor(private readonly handler: ReadRunSkillsHandler) {}

  async describe(names: readonly string[], commit: string): Promise<RunSkillDescriptionsRead> {
    const read = await this.handler.execute({ names, commit, include: 'descriptions' });
    if (read.status !== 'found') return read;
    return {
      status: 'found',
      skills: read.skills.map(({ name, description }) => ({ name, description })),
    };
  }

  async files(names: readonly string[], commit: string): Promise<RunSkillFilesRead> {
    const read = await this.handler.execute({ names, commit, include: 'files' });
    if (read.status !== 'found') return read;
    return {
      status: 'found',
      skills: read.skills.map(({ name, files }) => ({ name, files })),
      omitted: read.omitted,
    };
  }
}
