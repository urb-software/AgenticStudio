/**
 * The SecretStore port (ADR 0001, `security.md` §3): the only way to reach a secret value.
 * A business module stores a value and keeps the returned reference, resolves the reference
 * only at the point of authorized use, and deletes it when the secret is no longer needed.
 * It never sees ciphertext or the master key; this file has no crypto or database code.
 */

/** Opaque reference to a stored secret: what a business table holds instead of the value. */
export type SecretReference = string;

export interface SecretStore {
  /** Encrypts and stores `value`; returns a new reference to it. */
  put(value: string): Promise<SecretReference>;
  /**
   * Returns the value behind `reference`.
   * @throws {SecretNotFoundError} no secret exists under the reference.
   * @throws {SecretDecryptionFailedError} the stored value cannot be authenticated with the
   *   configured master key (tampered, wrong key or unknown key version); fails closed.
   */
  get(reference: SecretReference): Promise<string>;
  /** Deletes the secret behind `reference`; a no-op when it does not exist. */
  delete(reference: SecretReference): Promise<void>;
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
