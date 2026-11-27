import { randomUUID } from 'node:crypto';
import { createDatabaseClient, type DatabaseClient } from '@agentic-studio/database';
import { deployMigrations, deployMigrationsUpTo } from '@agentic-studio/database/migrations';
import { startPostgres, type TestService } from '@agentic-studio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BEFORE = '20261201100000_run_skills';
const T = '2026-11-20T10:00:00.000Z';
const COMMIT = 'c'.repeat(40);

type Value = string | number | boolean | null | { sql: string };
type Row = Record<string, Value>;

/** A Run as the database held it before the migration, with the columns the migration moves. */
interface Seeded {
  name: string;
  columns: Row;
  agent: {
    name: string;
    source: 'built_in' | 'definitions';
    commit: string | null;
    model: string;
    instructions: string;
    skills: string[];
  };
  sessionRef: string | null;
  stepsBeforePart: number;
  steps: number;
  messages: { kind: string; text: string; extra?: Row }[];
}

const BUILT_IN = {
  name: 'default-codex',
  source: 'built_in' as const,
  commit: null,
  model: 'default',
  instructions: '',
  skills: [],
};
const DEFINED = {
  name: 'reviewer',
  source: 'definitions' as const,
  commit: COMMIT,
  model: 'opus',
  instructions: 'Review "carefully".\nSecond line.',
  skills: ['notes', 'lint'],
};
const HELD = { claimed_by: { sql: 'gen_random_uuid()' }, heartbeat_at: T };

const RUNS: Seeded[] = [
  {
    name: 'queued, not started',
    columns: { state: 'queued' },
    agent: BUILT_IN,
    sessionRef: null,
    stepsBeforePart: 0,
    steps: 0,
    messages: [],
  },
  {
    name: 'preparing',
    columns: { state: 'preparing', started_at: T, ...HELD },
    agent: DEFINED,
    sessionRef: null,
    stepsBeforePart: 0,
    steps: 0,
    messages: [],
  },
  {
    name: 'running after a first Run step',
    columns: { state: 'running', started_at: T, step_started_at: T, ...HELD },
    agent: DEFINED,
    sessionRef: 'session-running',
    stepsBeforePart: 0,
    steps: 1,
    messages: [],
  },
  {
    name: 'waiting for an Answer to a Question',
    columns: { state: 'waiting_for_operator', started_at: T, waiting_since: T },
    agent: BUILT_IN,
    sessionRef: 'session-waiting',
    stepsBeforePart: 0,
    steps: 1,
    messages: [{ kind: 'question', text: 'Which database?' }],
  },
  {
    name: 'queued with an Answer, holding its place',
    columns: { state: 'queued', started_at: T, last_claimed_by: { sql: 'gen_random_uuid()' } },
    agent: DEFINED,
    sessionRef: 'session-answered',
    stepsBeforePart: 0,
    steps: 2,
    messages: [
      { kind: 'question', text: 'Which database?' },
      { kind: 'answer', text: 'PostgreSQL' },
    ],
  },
  {
    name: 'succeeded and delivered, with a Follow-up and a second part',
    columns: {
      state: 'succeeded',
      started_at: T,
      finished_at: T,
      delivery: 'delivered',
      pull_request_url: 'https://github.com/acme/shop/pull/7',
      pull_request_number: 7,
      follow_up_count: 1,
    },
    agent: DEFINED,
    sessionRef: 'session-delivered',
    stepsBeforePart: 2,
    steps: 3,
    messages: [
      { kind: 'question', text: 'Which database?' },
      { kind: 'answer', text: 'PostgreSQL' },
      { kind: 'part_end', text: 'Done.', extra: { end_state: 'succeeded' } },
      { kind: 'follow_up', text: 'Also handle HEAD.' },
    ],
  },
  {
    name: 'queued for a Follow-up it has not started',
    columns: {
      state: 'queued',
      started_at: T,
      follow_up_queued: true,
      follow_up_count: 1,
      last_claimed_by: { sql: 'gen_random_uuid()' },
    },
    agent: BUILT_IN,
    sessionRef: 'session-follow-up',
    stepsBeforePart: 2,
    steps: 2,
    messages: [{ kind: 'follow_up', text: 'Add a test.' }],
  },
  {
    name: 'failed at the usage limit, resumable',
    columns: { state: 'failed', started_at: T, finished_at: T },
    agent: DEFINED,
    sessionRef: 'session-limit',
    stepsBeforePart: 0,
    steps: 2,
    messages: [],
  },
  {
    name: 'failed with the delivery to retry',
    columns: {
      state: 'failed',
      started_at: T,
      finished_at: T,
      delivery: 'failed',
      delivery_requested: true,
    },
    agent: BUILT_IN,
    sessionRef: 'session-retry',
    stepsBeforePart: 0,
    steps: 1,
    messages: [],
  },
  {
    name: 'cancelled before it started',
    columns: {
      state: 'cancelled',
      finished_at: T,
      cancelled_by: 'operator',
      cancel_reason: 'Not needed.',
    },
    agent: BUILT_IN,
    sessionRef: null,
    stepsBeforePart: 0,
    steps: 0,
    messages: [],
  },
  {
    name: 'timed out',
    columns: { state: 'timed_out', started_at: T, finished_at: T },
    agent: DEFINED,
    sessionRef: null,
    stepsBeforePart: 0,
    steps: 1,
    messages: [],
  },
];

describe('the migration that gives every Run a Phase (PostgreSQL via Testcontainers)', () => {
  let postgres: TestService;
  let db: DatabaseClient;
  const ids = new Map<string, string>();
  let projectOfAnswered = '';

  async function insert(table: string, row: Row): Promise<string> {
    const names = Object.keys(row);
    const params: unknown[] = [];
    const values = names.map((name) => {
      const value = row[name]!;
      if (typeof value === 'object' && value !== null) return value.sql;
      params.push(value);
      return `$${params.length}`;
    });
    const [created] = await db.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ${table} (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${values.join(', ')}) RETURNING *`,
      ...params,
    );
    return created!.id;
  }

  async function seed(run: Seeded): Promise<string> {
    const projectName = `Shop ${randomUUID()}`;
    const projectId = await insert('projects', {
      name: projectName,
      name_normalized: projectName.toLowerCase(),
    });
    const id = await insert('runs', {
      project_id: projectId,
      provider: 'codex',
      task: 'Add a health check',
      start_commit: 'a'.repeat(40),
      remote_url: 'https://git.example.test/acme/shop.git',
      integration_branch: 'dev',
      limit_step_minutes: 60,
      limit_max_steps: 5,
      limit_waiting_days: 14,
      agent_name: run.agent.name,
      agent_source: run.agent.source,
      agent_commit: run.agent.commit,
      agent_provider: 'codex',
      agent_model: run.agent.model,
      agent_instructions: run.agent.instructions,
      agent_skills: {
        sql: `ARRAY[${run.agent.skills.map((skill) => `'${skill}'`).join(', ')}]::TEXT[]`,
      },
      session_ref: run.sessionRef,
      steps_before_part: run.stepsBeforePart,
      ...(run.columns.state === 'failed' && run.columns.delivery === undefined
        ? { failure_code: 'usage_limit', failure_detail: 'The usage limit was reached.' }
        : {}),
      ...(run.columns.delivery === 'failed'
        ? { failure_code: 'delivery_failed', failure_detail: 'The push was refused.' }
        : {}),
      ...run.columns,
    });
    for (let index = 1; index <= run.steps; index += 1) {
      await insert('run_steps', {
        run_id: id,
        index,
        kind: index === 1 ? 'start' : 'resume',
        result: { sql: `'{"outcome":"done","summary":"Step ${index}."}'::jsonb` },
      });
    }
    for (const [seq, message] of run.messages.entries()) {
      await insert('run_messages', {
        run_id: id,
        seq: seq + 1,
        kind: message.kind,
        text: message.text,
        at: T,
        ...message.extra,
      });
    }
    if (run.name.startsWith('queued with an Answer')) projectOfAnswered = projectId;
    return id;
  }

  beforeAll(async () => {
    postgres = await startPostgres();
    await deployMigrationsUpTo(postgres.url, BEFORE);
    db = createDatabaseClient(postgres.url);
    for (const run of RUNS) ids.set(run.name, await seed(run));
    await deployMigrations(postgres.url);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await postgres?.stop();
  });

  it.each(RUNS.map((run) => [run.name, run] as const))(
    'gives the Run %s one Phase with what the Run recorded, and loses no Run step or message',
    async (_name, run) => {
      const id = ids.get(run.name)!;

      const phases = await db.$queryRaw<
        {
          id: string;
          position: number;
          agent_name: string;
          agent_source: string;
          agent_commit: string | null;
          agent_provider: string;
          agent_model: string;
          agent_instructions: string;
          agent_skills: string[];
          session_ref: string | null;
          steps_before_part: number;
          item_id: string | null;
          kind: string;
          state: string;
          summary: string | null;
        }[]
      >`SELECT * FROM run_phases WHERE run_id = ${id}::uuid`;
      expect(phases).toEqual([
        {
          id: expect.any(String),
          run_id: id,
          position: 0,
          agent_name: run.agent.name,
          agent_source: run.agent.source,
          agent_commit: run.agent.commit,
          agent_provider: 'codex',
          agent_model: run.agent.model,
          agent_instructions: run.agent.instructions,
          agent_skills: run.agent.skills,
          session_ref: run.sessionRef,
          steps_before_part: run.stepsBeforePart,
          // Added by the Workflow migration, which also gives the Phase the state of its Run.
          item_id: null,
          kind: 'work',
          state: expect.stringMatching(/^(pending|running|done|failed)$/),
          summary: null,
          // Added by the review Phase migration.
          verdict: null,
          findings: null,
        },
      ]);

      const [stored] = await db.$queryRaw<
        { current_phase: number; has_session: boolean; state: string; follow_up_count: number }[]
      >`SELECT current_phase, has_session, state, follow_up_count FROM runs WHERE id = ${id}::uuid`;
      expect(stored).toEqual({
        current_phase: 0,
        has_session: run.sessionRef !== null,
        state: run.columns.state,
        follow_up_count: run.columns.follow_up_count ?? 0,
      });

      const steps = await db.$queryRaw<{ index: number; phase_id: string; result: unknown }[]>`
        SELECT "index", phase_id, result FROM run_steps WHERE run_id = ${id}::uuid ORDER BY "index"`;
      expect(steps.map((step) => step.index)).toEqual(
        Array.from({ length: run.steps }, (_unused, n) => n + 1),
      );
      expect(steps.every((step) => step.phase_id === phases[0]!.id)).toBe(true);
      expect(steps.map((step) => step.result)).toEqual(
        steps.map((step) => ({ outcome: 'done', summary: `Step ${step.index}.` })),
      );

      const messages = await db.$queryRaw<{ seq: number; kind: string; text: string }[]>`
        SELECT seq, kind, text FROM run_messages WHERE run_id = ${id}::uuid ORDER BY seq`;
      expect(messages).toEqual(
        run.messages.map((message, n) => ({ seq: n + 1, kind: message.kind, text: message.text })),
      );
    },
  );

  it('leaves no Run without a Phase and no Run step without one', async () => {
    const [counts] = await db.$queryRaw<{ runs: number; phases: number; orphans: number }[]>`
      SELECT (SELECT count(*) FROM runs)::int AS runs,
             (SELECT count(*) FROM run_phases)::int AS phases,
             (SELECT count(*) FROM run_steps s
               WHERE NOT EXISTS (SELECT 1 FROM run_phases p WHERE p.id = s.phase_id))::int AS orphans`;

    expect(counts).toEqual({ runs: RUNS.length, phases: RUNS.length, orphans: 0 });
  });

  it('indexes the Phase of a Run step, which every count of a Phase reads', async () => {
    const indexes = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE indexname = 'run_steps_phase_id_idx'`;

    expect(indexes).toHaveLength(1);
  });

  it('removes the columns that moved from the Run', async () => {
    const columns = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'runs'
        AND (column_name LIKE 'agent\\_%' OR column_name IN ('session_ref', 'steps_before_part'))`;

    expect(columns).toEqual([]);
  });

  it('still keeps a second active Run out of a project that holds a place with a session', async () => {
    const insertion = insert('runs', {
      project_id: projectOfAnswered,
      provider: 'codex',
      task: 'Another Run',
      start_commit: 'a'.repeat(40),
      remote_url: 'https://git.example.test/acme/shop.git',
      integration_branch: 'dev',
      limit_step_minutes: 60,
      limit_max_steps: 5,
      limit_waiting_days: 14,
      state: 'queued',
      has_session: true,
    });

    await expect(insertion).rejects.toThrow(/runs_one_active_per_project_key/);
  });

  it('refuses a Phase whose agent record disagrees with itself', async () => {
    const runId = ids.get('timed out')!;

    await expect(
      insert('run_phases', {
        run_id: runId,
        position: 1,
        agent_name: 'x',
        agent_source: 'definitions',
        agent_commit: null,
        agent_provider: 'codex',
        agent_model: 'default',
        agent_instructions: '',
      }),
    ).rejects.toThrow(/run_phases_agent_check/);
  });
});
