import { Injectable } from '@nestjs/common';
import type { RepositoryConnection } from '../../domain/entities/repository.js';

/** What a disconnect achieved: everything removed, or cleanup still pending. */
export type DisconnectOutcome =
  { disconnected: true } | { disconnected: false; repository: RepositoryConnection };

/** Command: Disconnect (glossary). Placeholder; implemented test-first next. */
@Injectable()
export class DisconnectRepositoryHandler {
  execute(projectId: string): Promise<DisconnectOutcome> {
    void projectId;
    return Promise.reject(new Error('Disconnect is not implemented yet.'));
  }
}
