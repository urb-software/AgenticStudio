import { SecretsModule } from '../../../../platform/secrets/secrets.module.js';

// Forbidden: only a Nest module file imports the wiring; a handler injects the port.
export class ConnectRepositoryHandler {
  readonly wiring = SecretsModule;
}
