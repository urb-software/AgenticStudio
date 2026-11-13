import type { SecretStore } from '../../../../platform/secrets/index.js';

export class ConnectRepositoryHandler {
  constructor(private readonly secrets: SecretStore) {}

  async execute(deployKey: string): Promise<string> {
    return this.secrets.put(deployKey);
  }
}
