const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SCP_REMOTE = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/i;

/** The GitHub repository a Project's remote names. */
export class GitHubRepository {
  private constructor(
    readonly owner: string,
    readonly name: string,
  ) {}

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /**
   * `https://github.com/<o>/<r>(.git)`, `git@github.com:<o>/<r>.git` and
   * `ssh://git@github.com/<o>/<r>.git`; `null` for any other host or shape.
   */
  static fromRemote(
    remoteUrl: string,
    options: { allowFileRemotes: boolean },
  ): GitHubRepository | null {
    const scp = SCP_REMOTE.exec(remoteUrl);
    if (scp) return GitHubRepository.named(scp[1], scp[2]);
    if (options.allowFileRemotes && remoteUrl.startsWith('file:///')) {
      const parts = remoteUrl.slice('file://'.length).split('/').filter(Boolean);
      return GitHubRepository.named(parts.at(-2), parts.at(-1));
    }
    let url: URL;
    try {
      url = new URL(remoteUrl);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) return null;
    const plainHttps = url.protocol === 'https:' && !url.username && !url.password && !url.port;
    const gitSsh = url.protocol === 'ssh:' && url.username === 'git' && !url.password;
    if (!plainHttps && !gitSsh) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 2 ? GitHubRepository.named(parts[0], parts[1]) : null;
  }

  private static named(owner: string | undefined, rawName: string | undefined) {
    const name = rawName?.replace(/\.git$/, '');
    if (!owner || !name || !OWNER.test(owner) || !REPO.test(name) || /^\.+$/.test(name)) {
      return null;
    }
    return new GitHubRepository(owner, name);
  }
}
