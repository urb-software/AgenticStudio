import { randomUUID } from 'node:crypto';
import { createDatabaseClient, type DatabaseClient } from '@agentic-studio/database';
import { deployMigrations, deployMigrationsUpTo } from '@agentic-studio/database/migrations';
import { startPostgres, type TestService } from '@agentic-studio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BEFORE = '20261205100000_review_phase';
const COMMIT = 'c'.repeat(40);

describe('the migration that adds send-backs (PostgreSQL via Testcontainers)', () => {
  let postgres: TestService;
  let db: DatabaseClient;
  let workflowRun = '';
  let agentRun = '';

  async function seed(workflow: boolean): Promise<string> {
    const name = `Shop ${randomUUID()}`;
    const [project] = await db.$queryRaw<{ id: string }[]>`
      INSERT INTO projects (name, name_normalized) VALUES (${name}, ${name.toLowerCase()})
      RETURNING id`;
    const [run] = workflow
      ? await db.$queryRaw<{ id: string }[]>`
          INSERT INTO runs (project_id, provider, task, state, start_commit, remote_url,
            integration_branch, limit_step_minutes, limit_max_steps, limit_waiting_days,
            workflow_name, workflow_commit, workflow_items)
          VALUES (${project!.id}::uuid, 'codex', 'Add a health check', 'queued', ${'a'.repeat(40)},
            'https://git.example.test/acme/shop.git', 'dev', 60, 5, 14,
            'flow', ${COMMIT}, '[{"id":"build","kind":"work","agent":"builder"}]'::jsonb)
          RETURNING id`
      : await db.$queryRaw<{ id: string }[]>`
          INSERT INTO runs (project_id, provider, task, state, start_commit, remote_url,
            integration_branch, limit_step_minutes, limit_max_steps, limit_waiting_days)
          VALUES (${project!.id}::uuid, 'codex', 'Add a health check', 'queued', ${'a'.repeat(40)},
            'https://git.example.test/acme/shop.git', 'dev', 60, 5, 14)
          RETURNING id`;
    return run!.id;
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await deployMigrationsUpTo(postgres.url, BEFORE);
    db = createDatabaseClient(postgres.url);
    workflowRun = await seed(true);
    agentRun = await seed(false);
    await deployMigrations(postgres.url);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await postgres?.stop();
  });

  it('gives a Workflow Run started before it a limit of none, as it was claimed under', async () => {
    const [row] = await db.$queryRaw<
      { workflow_send_backs: number | null; send_backs_used: number }[]
    >`SELECT workflow_send_backs, send_backs_used FROM runs WHERE id = ${workflowRun}::uuid`;

    expect(row).toEqual({ workflow_send_backs: 0, send_backs_used: 0 });
  });

  it('leaves a Run started with an agent without a limit', async () => {
    const [row] = await db.$queryRaw<{ workflow_send_backs: number | null }[]>`
      SELECT workflow_send_backs FROM runs WHERE id = ${agentRun}::uuid`;

    expect(row?.workflow_send_backs).toBeNull();
  });
});
