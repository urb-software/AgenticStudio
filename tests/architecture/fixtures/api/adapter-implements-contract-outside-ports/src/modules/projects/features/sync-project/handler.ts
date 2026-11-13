export interface GitClient {
  fetch(remoteUrl: string): Promise<void>;
}

export class SyncProjectHandler {
  constructor(private readonly git: GitClient) {}

  async execute(remoteUrl: string): Promise<void> {
    await this.git.fetch(remoteUrl);
  }
}
