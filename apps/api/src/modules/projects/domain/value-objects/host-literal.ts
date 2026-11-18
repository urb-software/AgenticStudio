export type HostLiteral =
  | { kind: 'name' }
  | { kind: 'address'; address: string }
  /** Looks numeric (every label is a number), but is no valid address: refused. */
  | { kind: 'invalid' };
