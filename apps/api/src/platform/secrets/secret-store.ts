/**
 * The SecretStore port (ADR 0001, `security.md` §3): the only way to reach a secret value.
 * A business module stores a value and keeps the returned reference, resolves the reference
 * only at the point of authorized use, and deletes it when the secret is no longer needed.
 * It never sees ciphertext or the master key; this file has no crypto or database code.
 */

/** Opaque reference to a stored secret: what a business table holds instead of the value. */
export type SecretReference = string;

/**
 * The label a business module stores its secrets under, `<module>.<kind>` (e.g.
 * `projects.deploy-key`, Issue #76): lower-case dot-separated segments of letters, digits and
 * hyphens, at most 64 characters. It is not secret. It lets a module find its own secrets
 * that nothing references any more ({@link SecretStore.listOlderThan}) without touching
 * another module's.
 */
export type SecretOwner = string;

export interface SecretStore {
  /**
   * Encrypts and stores `value` under the `owner` label; returns a new reference to it.
   * @throws {RangeError} the owner label is malformed; nothing is stored.
   */
  put(value: string, options: { owner: SecretOwner }): Promise<SecretReference>;
  /**
   * Returns the value behind `reference`.
   * @throws {SecretNotFoundError} no secret exists under the reference.
   * @throws {SecretDecryptionFailedError} the stored value cannot be authenticated with the
   *   configured master key (tampered, wrong key or unknown key version); fails closed.
   */
  get(reference: SecretReference): Promise<string>;
  /** Deletes the secret behind `reference`; a no-op when it does not exist. */
  delete(reference: SecretReference): Promise<void>;
  /**
   * The references, never the values, of the `owner`'s secrets stored at least `ageMs`
   * milliseconds ago, oldest first. The age is measured by the store's own clock, the one
   * that stamped each secret, so a caller's clock skew cannot make a fresh secret look old.
   * @throws {RangeError} the owner label is malformed, or `ageMs` is not a non-negative
   *   integer.
   */
  listOlderThan(owner: SecretOwner, ageMs: number): Promise<SecretReference[]>;
  // Every method throws SecretStoreUnavailableError when the backing store fails.
}

/** DI token for the {@link SecretStore}. */
export const SECRET_STORE = Symbol('SECRET_STORE');

/**
 * Base of the SecretStore's typed errors. Messages are fixed: they never carry a value,
 * ciphertext, key or the reference, and no lower-level error is attached as a cause.
 */
export abstract class SecretStoreError extends Error {}

export class SecretNotFoundError extends SecretStoreError {
  constructor() {
    super('The secret was not found.');
    this.name = 'SecretNotFoundError';
  }
}

export class SecretDecryptionFailedError extends SecretStoreError {
  constructor() {
    super('The secret could not be decrypted.');
    this.name = 'SecretDecryptionFailedError';
  }
}

/** The backing store failed (e.g. the database is unreachable); its error text is dropped. */
export class SecretStoreUnavailableError extends SecretStoreError {
  constructor() {
    super('The secret store is unavailable.');
    this.name = 'SecretStoreUnavailableError';
  }
}
