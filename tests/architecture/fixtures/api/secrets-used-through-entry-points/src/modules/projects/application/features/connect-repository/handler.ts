import type { SecretStore } from '../../../../../platform/secrets/index.js';

export type ConnectRepositoryInput = string;
export type ConnectRepositoryResult = string;

export class ConnectRepositoryHandler {
  constructor(private readonly secrets: SecretStore) {}

  async execute(deployKey: ConnectRepositoryInput): Promise<ConnectRepositoryResult> {
    return this.secrets.put(deployKey);
  }
}
