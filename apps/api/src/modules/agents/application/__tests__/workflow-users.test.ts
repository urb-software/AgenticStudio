import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import { describe, expect, it } from 'vitest';
import { AgentsReader, MAX_LISTED_WORKFLOW_FOLDERS } from '../agents-reader.js';
import { MAX_READ_BYTES, SkillsReader } from '../skills-reader.js';
import { BASE_COMMIT, FakeDefinitionsFiles, NEXT_COMMIT } from './fake-definitions-files.js';

const workflow = (name: string, ...agents: string[]) =>
  `---\nname: ${name}\ndescription: Does ${name}\nsequence:\n${agents
    .map((agent, index) => `  - id: p${index}\n    kind: work\n    agent: ${agent}`)
    .join('\n')}\n---\nNotes.\n`;

function reader(files: Record<string, string>) {
  const definitions = new FakeDefinitionsFiles(files);
  return { definitions, reader: new AgentsReader(definitions, new SkillsReader(definitions)) };
}

describe('AgentsReader.workflowUsers', () => {
  it('names the workflows whose sequence names the agent, sorted, valid or not', async () => {
    const { reader: agents } = reader({
      'workflows/zeta/WORKFLOW.md': workflow('zeta', 'builder'),
      'workflows/alpha/WORKFLOW.md': workflow('alpha', 'other', 'builder'),
      'workflows/other-only/WORKFLOW.md': workflow('other-only', 'other'),
      // Refused for its name, but the sequence still names the agent.
      'workflows/beta/WORKFLOW.md': workflow('not-beta', 'builder'),
    });

    await expect(agents.workflowUsers(BASE_COMMIT, 'builder')).resolves.toEqual({
      users: ['alpha', 'beta', 'zeta'],
      truncated: false,
    });
  });

  it('skips a folder whose entry file cannot be read as a workflow', async () => {
    const { reader: agents } = reader({
      'workflows/broken/WORKFLOW.md': 'no front matter',
      'workflows/nofile/readme.txt': 'x',
      'workflows/ok/WORKFLOW.md': workflow('ok', 'builder'),
    });

    await expect(agents.workflowUsers(BASE_COMMIT, 'builder')).resolves.toEqual({
      users: ['ok'],
      truncated: false,
    });
  });

  it('keeps the answer per commit and reads a new commit again', async () => {
    const { reader: agents, definitions } = reader({
      'workflows/one/WORKFLOW.md': workflow('one', 'builder'),
    });
    definitions.commit(NEXT_COMMIT, {
      'workflows/one/WORKFLOW.md': workflow('one', 'builder'),
      'workflows/two/WORKFLOW.md': workflow('two', 'builder'),
    });

    await agents.workflowUsers(BASE_COMMIT, 'builder');
    await agents.workflowUsers(BASE_COMMIT, 'other');
    expect(definitions.listTreeCalls).toBe(1);

    const next = await agents.workflowUsers(NEXT_COMMIT, 'builder');
    expect(next.users).toEqual(['one', 'two']);
    expect(definitions.listTreeCalls).toBe(2);
  });

  it('cuts at the list bound and says so', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_LISTED_WORKFLOW_FOLDERS + 3; index += 1) {
      const name = `w${String(index).padStart(3, '0')}`;
      files[`workflows/${name}/WORKFLOW.md`] = workflow(name, 'builder');
    }
    const { reader: agents } = reader(files);

    const { users, truncated } = await agents.workflowUsers(BASE_COMMIT, 'builder');

    expect(truncated).toBe(true);
    expect(users).toHaveLength(MAX_LISTED_WORKFLOW_FOLDERS);
    expect(users[users.length - 1]).toBe(`w${MAX_LISTED_WORKFLOW_FOLDERS - 1}`);
  });

  it('cuts at the read budget by declared bytes and says so', async () => {
    const files: Record<string, string> = {};
    const count = MAX_READ_BYTES / MAX_FILE_BYTES + 1;
    for (let index = 0; index < count; index += 1) {
      const name = `w${String(index).padStart(2, '0')}`;
      const text = workflow(name, 'builder');
      files[`workflows/${name}/WORKFLOW.md`] = text + 'x'.repeat(MAX_FILE_BYTES - text.length);
    }
    const { reader: agents } = reader(files);

    const { users, truncated } = await agents.workflowUsers(BASE_COMMIT, 'builder');

    expect(truncated).toBe(true);
    expect(users).toHaveLength(count - 1);
  });

  it('fails closed, and keeps nothing, when the Clone cannot be read', async () => {
    const { reader: agents, definitions } = reader({
      'workflows/one/WORKFLOW.md': workflow('one', 'builder'),
    });
    definitions.readFilesFails = true;

    await expect(agents.workflowUsers(BASE_COMMIT, 'builder')).resolves.toEqual({
      users: [],
      truncated: true,
    });
    definitions.readFilesFails = false;
    await expect(agents.workflowUsers(BASE_COMMIT, 'builder')).resolves.toEqual({
      users: ['one'],
      truncated: false,
    });
  });

  it('fails closed when the listing was cut', async () => {
    const { reader: agents, definitions } = reader({
      'workflows/one/WORKFLOW.md': workflow('one', 'builder'),
      'workflows/two/WORKFLOW.md': workflow('two', 'builder'),
    });
    definitions.truncated = true;

    const { users, truncated } = await agents.workflowUsers(BASE_COMMIT, 'builder');

    expect(truncated).toBe(true);
    expect(users).toEqual(['one']);
  });
});
