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
  PublishNotJudgedError,
  PublishNotConfiguredError,
  PublishPathOutsideDefinitionsError,
  PublishProblemsError,
  PublishRunningError,
  RepositoryMovedError,
  WriteRefusedError,
} from '../../../domain/errors/agent-publish-errors.js';
import {
  AGENTS_DIRECTORY,
  SKILLS_DIRECTORY,
  WORKFLOWS_DIRECTORY,
} from '@agentic-studio/agent-definitions';
import type { AgentDraft } from '../../../domain/entities/agent-draft.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';
import { PublishMessage } from '../../../domain/value-objects/publish-message.js';
import { AgentDraftBaseReader } from '../../agent-draft-base.js';
import { AgentDraftReader } from '../../agent-draft-reader.js';
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
 * view must still be the stored Draft, the Repository must hold its base, and no problem of a
 * skill, agent or workflow it touches may stand. A refusal leaves the Draft as it was; `agents` never touches Git.
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
    // Studio writes nothing but definitions to the Git host (no CI workflow, no dot-file).
    const outside = draft.files
      .map((file) => file.path)
      .filter(
        (path) =>
          ![AGENTS_DIRECTORY, SKILLS_DIRECTORY, WORKFLOWS_DIRECTORY].some((directory) =>
            path.startsWith(`${directory}/`),
          ),
      );
    if (outside.length > 0) throw new PublishPathOutsideDefinitionsError(outside);
    const base = await this.base.read(baseCommit);
    if (base.currentCommit !== baseCommit) throw new RepositoryMovedError();
    const judged = await this.reader.judge(draft);
    // Not judged is not "no problem": a Clone that cannot be read blocks the publish.
    if (!judged.judged) {
      if (judged.reason === 'over_limits') throw new PublishNotJudgedError();
      throw new PublishFailedError('repository_not_ready');
    }
    if (judged.agents.length > 0 || judged.skills.length > 0 || judged.workflows.length > 0) {
      throw new PublishProblemsError(judged.agents, judged.skills, judged.workflows);
    }

    const changes = await this.changesOf(draft, baseCommit, input.version);
    const result = await this.publisher.publish({
      baseCommit,
      changes,
      message: message.value,
      identity,
    });
    switch (result.status) {
      case 'published':
        await this.discard(input.version);
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

  /**
   * The Draft's files as `projects` commits them: bytes (or a delete) and the mode the base has.
   * Every save raises the version, so the same version before and after the bytes are read proves
   * that they are the bytes that were judged; any other is a conflict and nothing is pushed.
   */
  private async changesOf(
    draft: AgentDraft,
    baseCommit: string,
    version: number,
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
    if ((await this.drafts.find()).version !== version) throw new DraftChangedConcurrentlyError();
    return draft.files.map((file): DefinitionsPublishChange => {
      if (file.isDeleted) return { path: file.path, content: null, executable: false };
      const content = contents.get(file.path);
      if (content === undefined) throw new Error('The Draft holds no bytes for one of its files.');
      return { path: file.path, content, executable: modes.get(file.path) ?? false };
    });
  }

  /**
   * The push is done: one conditional discard of the published version only. A Draft that moved
   * on since keeps its edits, and its old base is then handled by the existing base-missing and
   * conflict answers.
   */
  private async discard(version: number): Promise<void> {
    const draft = await this.drafts.find();
    if (draft.version !== version) return;
    draft.discard(new Date());
    try {
      await this.drafts.save(draft, new Map());
    } catch (error) {
      if (!(error instanceof DraftChangedConcurrentlyError)) throw error;
    }
  }
}
