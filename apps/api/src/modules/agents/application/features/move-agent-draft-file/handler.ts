import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import { DEFINITIONS_FILES, type DefinitionsFiles } from '../../../../projects/contracts/index.js';
import { AgentDraftBaseReader } from '../../agent-draft-base.js';
import { AgentDraftReader, type AgentDraftView } from '../../agent-draft-reader.js';
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
 * base commit's otherwise (text only: a binary file or one over the limit cannot be carried).
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
   * Throws what {@link SaveAgentDraftFileHandler} and {@link DeleteAgentDraftFileHandler} throw
   * for the two paths, `DraftPathTakenError` and `DraftMoveUnsupportedError`.
   */
  async execute(input: MoveAgentDraftFileInput): Promise<MoveAgentDraftFileResult> {
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
    await this.drafts.save(draft, new Map([[input.to, content]]));
    return this.reader.read(draft);
  }

  private async contentOf(path: string, baseCommit: string): Promise<Uint8Array | null> {
    const stored = await this.drafts.findContent(path);
    if (stored) return stored;
    const read = await this.definitions.readFiles(baseCommit, [path], MAX_FILE_BYTES);
    if (read.status !== 'read') throw new DraftBaseUnreadableError();
    const file = read.files[0];
    if (!file || file.status === 'missing') return null;
    if (file.status === 'too_large') throw new DraftMoveUnsupportedError('too_large');
    if (file.binary) throw new DraftMoveUnsupportedError('binary');
    return Buffer.from(file.text, 'utf8');
  }
}
