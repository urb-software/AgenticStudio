import type { GitPort } from '../../application/ports/git-port.js';

export class CliGitClient implements GitPort {
  async fetch(remoteUrl: string): Promise<void> {
    void remoteUrl;
  }
}
