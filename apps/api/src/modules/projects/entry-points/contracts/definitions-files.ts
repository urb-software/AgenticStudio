import { Injectable } from '@nestjs/common';
import type {
  DefinitionsBlobIdsResult,
  DefinitionsBlobsResult,
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsSnapshot,
  DefinitionsTreeResult,
} from '../../contracts/index.js';
import { GetDefinitionsRepositoryStateHandler } from '../../application/features/get-definitions-repository-state/handler.js';
import { ListDefinitionsTreeHandler } from '../../application/features/list-definitions-tree/handler.js';
import { ReadDefinitionsBlobIdsHandler } from '../../application/features/read-definitions-blob-ids/handler.js';
import { ReadDefinitionsBlobsHandler } from '../../application/features/read-definitions-blobs/handler.js';
import { ReadDefinitionsFilesHandler } from '../../application/features/read-definitions-files/handler.js';

/**
 * The driving adapter of {@link DefinitionsFiles}: it maps the call to the handlers and holds no
 * rule.
 */
@Injectable()
export class ProjectDefinitionsFiles implements DefinitionsFiles {
  constructor(
    private readonly stateHandler: GetDefinitionsRepositoryStateHandler,
    private readonly treeHandler: ListDefinitionsTreeHandler,
    private readonly readHandler: ReadDefinitionsFilesHandler,
    private readonly blobsHandler: ReadDefinitionsBlobsHandler,
    private readonly blobIdsHandler: ReadDefinitionsBlobIdsHandler,
  ) {}

  async snapshot(): Promise<DefinitionsSnapshot | null> {
    const current = await this.stateHandler.execute();
    if (!current?.repository) return null;
    return { state: current.repository.state, commit: current.repository.headSha };
  }

  listTree(
    commit: string,
    options?: { whole?: boolean; directory?: 'agents' | 'skills' | 'workflows' },
  ): Promise<DefinitionsTreeResult> {
    return this.treeHandler.execute({
      commit,
      whole: options?.whole,
      directory: options?.directory,
    });
  }

  readFiles(
    commit: string,
    paths: readonly string[],
    maxBytes: number,
  ): Promise<DefinitionsFilesResult> {
    return this.readHandler.execute({ commit, paths, maxBytes });
  }

  readBlobs(
    commit: string,
    paths: readonly string[],
    maxBytes: number,
  ): Promise<DefinitionsBlobsResult> {
    return this.blobsHandler.execute({ commit, paths, maxBytes });
  }

  blobIds(commit: string, paths: readonly string[]): Promise<DefinitionsBlobIdsResult> {
    return this.blobIdsHandler.execute({ commit, paths });
  }
}
