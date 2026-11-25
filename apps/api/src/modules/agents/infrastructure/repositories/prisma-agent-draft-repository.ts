import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import { AgentDraft } from '../../domain/entities/agent-draft.js';
import { DraftChangedConcurrentlyError } from '../../domain/errors/agent-draft-errors.js';
import type { AgentDraftRepository } from '../../domain/repositories/agent-draft-repository.js';
import {
  AGENT_DRAFT_CHANGES,
  type AgentDraftChange,
} from '../../domain/value-objects/agent-draft-file.js';

/** The one Draft's row, which the `agent_drafts_single_check` constraint keeps single. */
const DRAFT_ID = 1;

function changeOf(value: string): AgentDraftChange {
  const change = AGENT_DRAFT_CHANGES.find((candidate) => candidate === value);
  if (!change) throw new Error('A stored Draft file has an unknown change.');
  return change;
}

/** PostgreSQL adapter of {@link AgentDraftRepository}: the `agent_drafts` and `agent_draft_files` tables. */
@Injectable()
export class PrismaAgentDraftRepository implements AgentDraftRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async find(): Promise<AgentDraft> {
    const [head, files] = await this.db.$transaction([
      this.db.agentDraft.findUnique({ where: { id: DRAFT_ID } }),
      this.db.agentDraftFile.findMany({
        select: { path: true, change: true, size: true, movedFrom: true, updatedAt: true },
        orderBy: { path: 'asc' },
      }),
    ]);
    if (!head) return AgentDraft.empty(new Date());
    return AgentDraft.restore({
      baseCommit: head.baseCommit,
      version: head.version,
      updatedAt: head.updatedAt,
      files: files.map((file) => ({
        path: file.path,
        change: changeOf(file.change),
        size: file.size,
        movedFrom: file.movedFrom,
        updatedAt: file.updatedAt,
      })),
    });
  }

  async save(draft: AgentDraft, contents: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const data = draft.toData();
    await this.db.$transaction(async (tx) => {
      const head = {
        baseCommit: data.baseCommit,
        version: data.version,
        updatedAt: data.updatedAt,
      };
      // Only while the stored version is the one this Draft was loaded at: the update takes the
      // row lock, so a write racing this one waits and then finds the version moved on.
      const updated = await tx.agentDraft.updateMany({
        where: { id: DRAFT_ID, version: draft.loadedVersion },
        data: head,
      });
      if (updated.count === 0) throw new DraftChangedConcurrentlyError();
      await tx.agentDraftFile.deleteMany({
        where: { path: { notIn: data.files.map((file) => file.path) } },
      });
      const stored = await tx.agentDraftFile.findMany({ select: { path: true, updatedAt: true } });
      const storedAt = new Map(stored.map((row) => [row.path, row.updatedAt.getTime()]));
      for (const file of data.files) {
        const bytes = contents.get(file.path);
        if (bytes === undefined && storedAt.get(file.path) === file.updatedAt.getTime()) continue;
        const fields = {
          change: file.change,
          size: file.size,
          movedFrom: file.movedFrom,
          updatedAt: file.updatedAt,
        };
        // A deleted file has no bytes; any other keeps its stored bytes unless new ones came.
        const content =
          file.change === 'deleted' ? null : bytes ? new Uint8Array(bytes) : undefined;
        await tx.agentDraftFile.upsert({
          where: { path: file.path },
          create: { path: file.path, ...fields, content: content ?? null },
          update: { ...fields, ...(content === undefined ? {} : { content }) },
        });
      }
    });
  }

  async findContent(path: string): Promise<Uint8Array | null> {
    const row = await this.db.agentDraftFile.findUnique({
      where: { path },
      select: { content: true },
    });
    return row?.content ?? null;
  }

  async findContents(paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>> {
    const rows = await this.db.agentDraftFile.findMany({
      where: { path: { in: [...paths] }, content: { not: null } },
      select: { path: true, content: true },
    });
    return new Map(
      rows.flatMap((row) => (row.content === null ? [] : [[row.path, row.content] as const])),
    );
  }
}
