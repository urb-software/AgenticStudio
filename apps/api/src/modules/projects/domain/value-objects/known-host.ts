export interface KnownHost {
  /** Lower-case known_hosts names: `host`, or `[host]:port` for a port other than 22. */
  readonly hosts: readonly string[];
  readonly key: string;
}
