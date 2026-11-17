import { SecretsModule } from '../../platform/secrets/secrets.module.js';
import { ConnectRepositoryHandler } from './application/features/connect-repository/handler.js';

export const ProjectsModule = { imports: [SecretsModule], providers: [ConnectRepositoryHandler] };
