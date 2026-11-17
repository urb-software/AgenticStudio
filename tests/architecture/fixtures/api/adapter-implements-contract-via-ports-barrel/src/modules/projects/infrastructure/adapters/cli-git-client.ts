import type { GitClient } from '../../application/ports/index.js';

export class CliGitClient implements GitClient {
  async fetch(remoteUrl: string): Promise<void> {
    void remoteUrl;
  }
}
