import { Injectable } from '@nestjs/common';
import type { RepositoryConnection } from '../../domain/entities/repository.js';

export interface VerifyRepositoryInput {
  projectId: string;
  /** The fingerprint the operator confirmed, when the Repository is `awaiting_host_key`. */
  acceptHostKeyFingerprint?: string;
}

/** The confirmed fingerprint is not the one of the host key awaiting confirmation. */
export class HostKeyFingerprintMismatchError extends Error {
  constructor() {
    super(
      'The fingerprint does not match the host key Studio retrieved. Verify again to retrieve the host key again.',
    );
    this.name = 'HostKeyFingerprintMismatchError';
  }
}

/** Command: Verify and clone (Issue #62). The contract only; implemented test-first next. */
@Injectable()
export class VerifyRepositoryHandler {
  execute(input: VerifyRepositoryInput): Promise<RepositoryConnection> {
    void input;
    return Promise.reject(new Error('Not implemented yet.'));
  }
}
