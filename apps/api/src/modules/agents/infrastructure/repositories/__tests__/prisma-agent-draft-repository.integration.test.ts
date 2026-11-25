import { createDatabaseClient, type DatabaseClient } from '@agentic-studio/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startStudioServices,
  type StudioServices,
} from '../../../../../__tests__/studio-test-app.js';
import { DraftChangedConcurrentlyError } from '../../../domain/errors/agent-draft-errors.js';
import { PrismaAgentDraftRepository } from '../prisma-agent-draft-repository.js';

// The real store on PostgreSQL (Testcontainers): the guarantees the handlers rely on.

const facts = { currentCommit: 'a'.repeat(40), baseEntries: [], now: new Date() };
const bytes = (value: number) => new Uint8Array([value]);

describe('PrismaAgentDraftRepository (PostgreSQL via Testcontainers)', () => {
  let services: StudioServices;
  let db: DatabaseClient;
  let store: PrismaAgentDraftRepository;

  beforeAll(async () => {
    services = await startStudioServices();
    db = createDatabaseClient(services.config.databaseUrl);
    store = new PrismaAgentDraftRepository(db);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await services?.stop();
  });

  beforeEach(async () => {
    await db.$executeRaw`DELETE FROM agent_draft_files`;
    await db.$executeRaw`DELETE FROM agent_drafts`;
    await db.$executeRaw`INSERT INTO agent_drafts (id, version, updated_at) VALUES (1, 0, now())`;
  });

  it('refuses a stale save and writes nothing', async () => {
    const first = await store.find();
    const second = await store.find();
    first.put({ ...facts, path: 'one.md', size: 1 });
    second.put({ ...facts, path: 'two.md', size: 1 });
    await store.save(first, new Map([['one.md', bytes(1)]]));

    await expect(store.save(second, new Map([['two.md', bytes(2)]]))).rejects.toThrow(
      DraftChangedConcurrentlyError,
    );

    const after = await store.find();
    expect(after.version).toBe(1);
    expect(after.files.map((file) => file.path)).toEqual(['one.md']);
    expect(await store.findContent('one.md')).toEqual(bytes(1));
    expect(await store.findContent('two.md')).toBeNull();
  });

  it('refuses a stale save made against a Draft that was discarded meanwhile', async () => {
    const writer = await store.find();
    const discarder = await store.find();
    discarder.discard(new Date());
    await store.save(discarder, new Map());
    writer.put({ ...facts, path: 'late.md', size: 1 });

    await expect(store.save(writer, new Map([['late.md', bytes(1)]]))).rejects.toThrow(
      DraftChangedConcurrentlyError,
    );

    expect((await store.find()).files).toEqual([]);
  });

  it('stores the next version from the one it loaded, and keeps unchanged bytes', async () => {
    const draft = await store.find();
    draft.put({ ...facts, path: 'one.md', size: 1 });
    await store.save(draft, new Map([['one.md', bytes(1)]]));
    const next = await store.find();
    next.put({ ...facts, path: 'two.md', size: 1 });
    await store.save(next, new Map([['two.md', bytes(2)]]));

    const after = await store.find();

    expect(after.version).toBe(2);
    expect(after.files.map((file) => file.path)).toEqual(['one.md', 'two.md']);
    expect(await store.findContent('one.md')).toEqual(bytes(1));
  });

  it('throws a clear error when the seeded row is missing', async () => {
    await db.$executeRaw`DELETE FROM agent_drafts`;

    await expect(store.find()).rejects.toThrow(/row is missing/);
  });
});
