import type { GitPort } from '../../ports/git-port.js';

export class CliGitClient implements GitPort {
  async fetch(remoteUrl: string): Promise<void> {
    void remoteUrl;
  }
}
