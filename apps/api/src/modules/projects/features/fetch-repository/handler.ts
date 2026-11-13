import { Injectable } from '@nestjs/common';
import type { RepositoryConnection } from '../../domain/entities/repository.js';

/** Command: Fetch (glossary). Contract placeholder; implemented test-first next. */
@Injectable()
export class FetchRepositoryHandler {
  execute(projectId: string): Promise<RepositoryConnection> {
    void projectId;
    return Promise.reject(new Error('Fetch is not implemented yet.'));
  }
}
