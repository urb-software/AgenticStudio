import { Injectable } from '@nestjs/common';
import { ReadAgentFolderHandler } from '../../application/features/read-agent-folder/handler.js';
import type { AgentFolderRead, AgentFolders } from '../../contracts/index.js';

/** The driving adapter of {@link AgentFolders}: it maps the call to the handler and holds no rule. */
@Injectable()
export class ReadAgentFolderAgentFolders implements AgentFolders {
  constructor(private readonly handler: ReadAgentFolderHandler) {}

  folderAt(name: string, commit: string): Promise<AgentFolderRead> {
    return this.handler.execute({ name, commit });
  }
}
