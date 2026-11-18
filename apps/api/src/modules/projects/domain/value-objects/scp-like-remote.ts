import { SCP_LIKE } from './remote-identity.js';
import type { SshRemote } from './ssh-remote.js';

/** A remote written in the short SSH form, `user@host:path`. */
export class ScpLikeRemote {
  private constructor(
    readonly user: string,
    readonly host: string,
    readonly path: string,
  ) {}

  /** `null` when the text is not in the short form. */
  static of(input: string): ScpLikeRemote | null {
    const match = SCP_LIKE.exec(input);
    if (!match) return null;
    const [, user = '', host = '', path = ''] = match;
    return new ScpLikeRemote(user, host, path);
  }

  /** A path segment starting with `-` would read as an option to Git. */
  get hasOptionLikeSegment(): boolean {
    return this.path.split('/').some((segment) => segment.startsWith('-'));
  }

  /** The Git host it names: SSH's default port. */
  get ssh(): SshRemote {
    return { host: this.host.toLowerCase(), port: 22 };
  }
}
