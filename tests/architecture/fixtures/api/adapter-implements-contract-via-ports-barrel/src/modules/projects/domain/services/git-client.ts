export interface GitClient {
  fetch(remoteUrl: string): Promise<void>;
}
