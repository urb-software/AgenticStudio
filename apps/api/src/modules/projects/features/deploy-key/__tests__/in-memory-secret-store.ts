import { randomUUID } from 'node:crypto';
import {
  SecretNotFoundError,
  type SecretOwner,
  type SecretReference,
  type SecretStore,
} from '../../../../../platform/secrets/index.js';

/**
 * An in-memory {@link SecretStore} for handler tests: values and owner labels by reference,
 * stamped with the store's own clock `now` (milliseconds, advanced by the test). `failWith`
 * makes the next calls reject (an unavailable store); `failNextDeleteWith` makes only the next
 * delete reject.
 */
export class InMemorySecretStore implements SecretStore {
  readonly values = new Map<SecretReference, string>();
  readonly owners = new Map<SecretReference, SecretOwner>();
  private readonly storedAt = new Map<SecretReference, number>();
  now = 0;
  failWith: Error | undefined;
  failNextDeleteWith: Error | undefined;

  put(value: string, { owner }: { owner: SecretOwner }): Promise<SecretReference> {
    if (this.failWith) return Promise.reject(this.failWith);
    const reference = randomUUID();
    this.values.set(reference, value);
    this.owners.set(reference, owner);
    this.storedAt.set(reference, this.now);
    return Promise.resolve(reference);
  }

  get(reference: SecretReference): Promise<string> {
    if (this.failWith) return Promise.reject(this.failWith);
    const value = this.values.get(reference);
    return value === undefined ? Promise.reject(new SecretNotFoundError()) : Promise.resolve(value);
  }

  delete(reference: SecretReference): Promise<void> {
    const failure = this.failWith ?? this.failNextDeleteWith;
    this.failNextDeleteWith = undefined;
    if (failure) return Promise.reject(failure);
    this.values.delete(reference);
    this.owners.delete(reference);
    this.storedAt.delete(reference);
    return Promise.resolve();
  }

  listOlderThan(owner: SecretOwner, ageMs: number): Promise<SecretReference[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(
      [...this.storedAt]
        .filter(([reference, at]) => this.owners.get(reference) === owner && this.now - at >= ageMs)
        .sort(([, a], [, b]) => a - b)
        .map(([reference]) => reference),
    );
  }
}
