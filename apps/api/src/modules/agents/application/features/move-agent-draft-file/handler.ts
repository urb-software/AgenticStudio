import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import { DEFINITIONS_FILES, type DefinitionsFiles } from '../../../../projects/contracts/index.js';
import { AgentDraftBaseReader } from '../../agent-draft-base.js';
import {
  AgentDraftReader,
  DRAFT_WRITE_ATTEMPTS,
  type AgentDraftView,
} from '../../agent-draft-reader.js';
import { DraftChangedConcurrentlyError } from '../../../domain/errors/agent-draft-errors.js';
import {
  DraftBaseUnreadableError,
  DraftFileNotFoundError,
  DraftMoveUnsupportedError,
} from '../../../domain/errors/agent-draft-errors.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../../../domain/repositories/agent-draft-repository.js';

export interface MoveAgentDraftFileInput {
  from: string;
  to: string;
}

export type MoveAgentDraftFileResult = AgentDraftView;

/**
 * Moves a file inside the Draft: its content is the Draft's when the Draft holds the file, and the
 * base commit's stored bytes otherwise (a file over the file limit is not carried).
 */
@Injectable()
export class MoveAgentDraftFileHandler {
  constructor(
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
    @Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles,
    private readonly base: AgentDraftBaseReader,
    private readonly reader: AgentDraftReader,
  ) {}

  /**
   * Throws what saving to the new path and deleting the old one throw, `DraftPathTakenError`,
   * `DraftMoveUnsupportedError` and `DraftChangedConcurrentlyError`.
   */
  async execute(input: MoveAgentDraftFileInput): Promise<MoveAgentDraftFileResult> {
    for (let attempt = 1; ; attempt += 1) {
      const draft = await this.drafts.find();
      const base = await this.base.read(draft.baseCommit);
      const content = await this.contentOf(input.from, base.commit);
      draft.move({
        from: input.from,
        to: input.to,
        // A missing source has no content: the entity says why it cannot move.
        size: content?.byteLength ?? 0,
        currentCommit: base.currentCommit,
        baseEntries: base.entries,
        now: new Date(),
      });
      if (!content) throw new DraftFileNotFoundError(input.from);
      try {
        await this.drafts.save(draft, new Map([[input.to, content]]));
      } catch (error) {
        if (error instanceof DraftChangedConcurrentlyError && attempt < DRAFT_WRITE_ATTEMPTS)
          continue;
        throw error;
      }
      return this.reader.read(draft);
    }
  }

  private async contentOf(path: string, baseCommit: string): Promise<Uint8Array | null> {
    const stored = await this.drafts.findContent(path);
    if (stored) return stored;
    const read = await this.definitions.readBlobs(baseCommit, [path], MAX_FILE_BYTES);
    if (read.status !== 'read') throw new DraftBaseUnreadableError();
    const file = read.files[0];
    if (file?.status === 'found') return file.bytes;
    if (file?.status === 'too_large') throw new DraftMoveUnsupportedError();
    return null;
  }
}
