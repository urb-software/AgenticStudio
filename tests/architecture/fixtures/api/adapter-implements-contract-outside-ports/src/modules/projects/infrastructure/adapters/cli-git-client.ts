import type { GitClient } from '../../application/features/sync-project/handler.js';

export class CliGitClient implements GitClient {
  async fetch(remoteUrl: string): Promise<void> {
    void remoteUrl;
  }
}
