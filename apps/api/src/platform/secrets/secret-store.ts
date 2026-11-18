/** The SecretStore port: the only way to reach a secret value; it never exposes ciphertext. */

/** Opaque reference to a stored secret: what a business table holds instead of the value. */
export type SecretReference = string;

/**
 * The non-secret label a module stores its secrets under, `<module>.<kind>` (lower-case
 * dot-separated segments, at most 64 characters), so it can find its own unreferenced secrets
 * ({@link SecretStore.listOlderThan}) without touching another module's.
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
   * @throws {SecretNotFoundError} no such secret.
   * @throws {SecretDecryptionFailedError} it does not authenticate; fails closed.
   */
  get(reference: SecretReference): Promise<string>;
  /** Deletes the secret behind `reference`; a no-op when it does not exist. */
  delete(reference: SecretReference): Promise<void>;
  /**
   * The references (never values) of the `owner`'s secrets at least `ageMs` old, oldest first,
   * by the store's own clock so caller clock skew cannot age a fresh secret.
   * @throws {RangeError} the owner label is malformed or `ageMs` is not a non-negative integer.
   */
  listOlderThan(owner: SecretOwner, ageMs: number): Promise<SecretReference[]>;
  // Every method throws SecretStoreUnavailableError when the backing store fails.
}

/** DI token for the {@link SecretStore}. */
export const SECRET_STORE = Symbol('SECRET_STORE');

/** Base of the typed errors; messages are fixed: no value, ciphertext, key or reference. */
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
