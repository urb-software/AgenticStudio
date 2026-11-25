import { agentFolderQuerySchema } from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';

export class AgentFolderQueryDto extends createZodDto(agentFolderQuerySchema) {}
