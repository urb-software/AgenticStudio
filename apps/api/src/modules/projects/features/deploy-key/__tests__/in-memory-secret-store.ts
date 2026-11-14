import { randomUUID } from 'node:crypto';
import {
  SecretNotFoundError,
  type SecretReference,
  type SecretStore,
} from '../../../../../platform/secrets/index.js';

/**
 * An in-memory {@link SecretStore} for handler tests: values by reference, `failWith` makes
 * the next calls reject (an unavailable store).
 */
export class InMemorySecretStore implements SecretStore {
  readonly values = new Map<SecretReference, string>();
  failWith: Error | undefined;

  put(value: string): Promise<SecretReference> {
    if (this.failWith) return Promise.reject(this.failWith);
    const reference = randomUUID();
    this.values.set(reference, value);
    return Promise.resolve(reference);
  }

  get(reference: SecretReference): Promise<string> {
    if (this.failWith) return Promise.reject(this.failWith);
    const value = this.values.get(reference);
    return value === undefined ? Promise.reject(new SecretNotFoundError()) : Promise.resolve(value);
  }

  delete(reference: SecretReference): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.values.delete(reference);
    return Promise.resolve();
  }
}
