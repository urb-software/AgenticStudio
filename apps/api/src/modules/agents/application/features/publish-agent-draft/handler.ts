import { Inject, Injectable } from '@nestjs/common';
import {
  DEFINITIONS_FILES,
  DEFINITIONS_PUBLISH,
  type DefinitionsFiles,
  type DefinitionsPublish,
  type DefinitionsPublishChange,
} from '../../../../projects/contracts/index.js';
import {
  DraftBaseUnreadableError,
  DraftChangedConcurrentlyError,
} from '../../../domain/errors/agent-draft-errors.js';
import {
  NothingToPublishError,
  PublishFailedError,
  PublishNotConfiguredError,
  PublishProblemsError,
  PublishRunningError,
  RepositoryMovedError,
  WriteRefusedError,
} from '../../../domain/errors/agent-publish-errors.js';
import type { AgentDraft } from '../../../domain/entities/agent-draft.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';
import { PublishMessage } from '../../../domain/value-objects/publish-message.js';
import { AgentDraftBaseReader } from '../../agent-draft-base.js';
import { AgentDraftReader, DRAFT_WRITE_ATTEMPTS } from '../../agent-draft-reader.js';
import {
  DEFINITIONS_COMMIT_IDENTITY,
  type CommitIdentity,
  type CommitIdentitySource,
} from '../../ports/commit-identity.js';
import { PUBLISH_LOCK, type PublishLock } from '../../ports/publish-lock.js';

export interface PublishAgentDraftInput {
  message: string;
  /** The Draft's base commit as the page showed it. */
  baseCommit: string;
  /** The Draft's version as the page showed it. */
  version: number;
}

export interface PublishAgentDraftResult {
  /** The commit now on the Integration branch. */
  commit: string;
}

/**
 * Publishes the Draft as one commit on the Integration branch, one publish at a time. The page's
 * view must still be the stored Draft, the Repository must hold its base, and no problem may stand.
 * A refused publish leaves the Draft as it was; `agents` never touches Git.
 */
@Injectable()
export class PublishAgentDraftHandler {
  constructor(
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
    private readonly base: AgentDraftBaseReader,
    private readonly reader: AgentDraftReader,
    @Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles,
    @Inject(DEFINITIONS_PUBLISH) private readonly publisher: DefinitionsPublish,
    @Inject(PUBLISH_LOCK) private readonly lock: PublishLock,
    @Inject(DEFINITIONS_COMMIT_IDENTITY) private readonly identity: CommitIdentitySource,
  ) {}

  /**
   * Throws the publish errors of `domain/errors/agent-publish-errors.ts`, `InvalidPublishMessageError`,
   * `DraftChangedConcurrentlyError` and the base errors of the Draft's reader.
   */
  async execute(input: PublishAgentDraftInput): Promise<PublishAgentDraftResult> {
    const identity = this.identity.get();
    if (!identity) throw new PublishNotConfiguredError();
    const message = PublishMessage.of(input.message);
    const outcome = await this.lock.runExclusive(() => this.publish(input, message, identity));
    if (!outcome.ran) throw new PublishRunningError();
    return outcome.value;
  }

  private async publish(
    input: PublishAgentDraftInput,
    message: PublishMessage,
    identity: CommitIdentity,
  ): Promise<PublishAgentDraftResult> {
    const draft = await this.drafts.find();
    if (draft.version !== input.version) throw new DraftChangedConcurrentlyError();
    if (draft.files.length === 0) throw new NothingToPublishError();
    const baseCommit = draft.baseCommit;
    if (baseCommit === null || baseCommit !== input.baseCommit) {
      throw new DraftChangedConcurrentlyError();
    }
    const base = await this.base.read(baseCommit);
    if (base.currentCommit !== baseCommit) throw new RepositoryMovedError();
    const view = await this.reader.read(draft);
    if (view.problems.length > 0) throw new PublishProblemsError(view.problems);

    const result = await this.publisher.publish({
      baseCommit,
      changes: await this.changesOf(draft, baseCommit),
      message: message.value,
      identity,
    });
    switch (result.status) {
      case 'published':
        await this.discard();
        return { commit: result.commit };
      case 'repository_moved':
        throw new RepositoryMovedError();
      case 'write_refused':
        throw new WriteRefusedError();
      case 'nothing_to_publish':
        throw new NothingToPublishError();
      default:
        throw new PublishFailedError(result.status);
    }
  }

  /** The Draft's files as `projects` commits them: bytes (or a delete) and the mode the base has. */
  private async changesOf(
    draft: AgentDraft,
    baseCommit: string,
  ): Promise<DefinitionsPublishChange[]> {
    const written = draft.files.filter((file) => !file.isDeleted);
    const contents = await this.drafts.findContents(written.map((file) => file.path));
    // A new file is a plain file; a modified one keeps the base's executable bit.
    const modified = written.filter((file) => file.change === 'modified').map((file) => file.path);
    const modes = new Map<string, boolean>();
    if (modified.length > 0) {
      const ids = await this.definitions.blobIds(baseCommit, modified);
      if (ids.status !== 'read') throw new DraftBaseUnreadableError();
      for (const { path, executable } of ids.blobs) modes.set(path, executable);
    }
    return draft.files.map((file): DefinitionsPublishChange => {
      if (file.isDeleted) return { path: file.path, content: null, executable: false };
      const content = contents.get(file.path);
      if (content === undefined) throw new Error('The Draft holds no bytes for one of its files.');
      return { path: file.path, content, executable: modes.get(file.path) ?? false };
    });
  }

  /**
   * The push is done: the Draft goes, as a discard does. When other writes keep getting in, the
   * commit is still the answer: it is published whatever becomes of the Draft's rows.
   */
  private async discard(): Promise<void> {
    for (let attempt = 1; attempt <= DRAFT_WRITE_ATTEMPTS; attempt += 1) {
      const draft = await this.drafts.find();
      draft.discard(new Date());
      try {
        await this.drafts.save(draft, new Map());
        return;
      } catch (error) {
        if (!(error instanceof DraftChangedConcurrentlyError)) throw error;
      }
    }
  }
}
