export interface GitClient {
  fetch(remoteUrl: string): Promise<void>;
}

export type SyncProjectInput = string;

export class SyncProjectHandler {
  constructor(private readonly git: GitClient) {}

  async execute(remoteUrl: SyncProjectInput): Promise<void> {
    await this.git.fetch(remoteUrl);
  }
}
