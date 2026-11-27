import {
  checkWorkflowAgents,
  validateWorkflowFolder,
  WORKFLOW_ENTRY_FILE,
} from '@agentic-studio/agent-definitions';
import { describe, expect, it } from 'vitest';
import type { AgentSummaryOutput } from '../../../platform/api';
import type { EditorEntry } from '../features/agent-editor/editor-model';
import {
  agentStandings,
  diagramItems,
  fromBaseWorkflow,
  fromDraftWorkflow,
  namedWorkflows,
  newWorkflowFile,
  validateWorkflowLive,
  workflowNameError,
  workflowOfPath,
  workflowsNaming,
  workflowsWarning,
} from '../features/agent-editor/workflow-model';

const entry = (path: string, overrides: Partial<EditorEntry> = {}): EditorEntry => ({
  path,
  kind: 'file',
  size: 20,
  openable: true,
  agent: /^agents\/([^/]+)\//.exec(path)?.[1] ?? null,
  skill: null,
  workflow: workflowOfPath(path),
  ...overrides,
});

const FLOW = (agents: string[], extra = '') =>
  `---\nname: ship\ndescription: Does ship\n${extra}sequence:\n${agents
    .map((agent, index) => `  - id: p${index}\n    kind: work\n    agent: ${agent}`)
    .join('\n')}\n---\nNotes.\n`;

const valid = (...names: string[]) => new Map(names.map((name) => [name, { valid: true }]));

const live = (text: string | undefined, standings = valid('builder'), entries?: EditorEntry[]) =>
  validateWorkflowLive(
    'ship',
    entries ?? [entry('workflows/ship/WORKFLOW.md')],
    text,
    new Map(),
    standings,
  );

describe('newWorkflowFile and workflowNameError', () => {
  it('makes an entry file that names two placeholder agents and passes once they exist', () => {
    const text = newWorkflowFile('fresh');
    const folder = [
      { path: WORKFLOW_ENTRY_FILE, kind: 'file' as const, size: text.length, content: text },
    ];

    const result = validateWorkflowFolder('fresh', folder);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.sequence.map((item) => [item.id, item.kind])).toEqual([
      ['implement', 'work'],
      ['review', 'review'],
    ]);
    expect(checkWorkflowAgents(result.definition, valid('implementer', 'reviewer'))).toEqual([]);
    expect(checkWorkflowAgents(result.definition, valid()).map((problem) => problem.code)).toEqual([
      'phase_agent_missing',
      'phase_agent_missing',
    ]);
  });

  it.each(['123', 'true', 'null', '1e5', '0x1f', 'false'])(
    'makes an entry file that passes the validation for the name %s',
    (name) => {
      const text = newWorkflowFile(name);

      expect(
        validateWorkflowFolder(name, [
          { path: WORKFLOW_ENTRY_FILE, kind: 'file', size: text.length, content: text },
        ]).ok,
      ).toBe(true);
    },
  );

  it('refuses an empty, a malformed and a taken name', () => {
    expect(workflowNameError('', new Set())).toMatch(/Enter a name/);
    expect(workflowNameError('Bad Name', new Set())).toMatch(/lower-case/);
    expect(workflowNameError('ship', new Set(['ship']))).toMatch(/already exists/);
    expect(workflowNameError('ship', new Set(['other']))).toBeUndefined();
  });
});

describe('workflowOfPath', () => {
  it('names the workflow folder a path is in', () => {
    expect(workflowOfPath('workflows/ship/WORKFLOW.md')).toBe('ship');
    expect(workflowOfPath('workflows/ship/deep/a.md')).toBe('ship');
    expect(workflowOfPath('workflows/stray.md')).toBeNull();
    expect(workflowOfPath('agents/a/AGENT.md')).toBeNull();
  });
});

describe('validateWorkflowLive', () => {
  it('has no answer while the entry text is not known', () => {
    expect(live(undefined)).toBeUndefined();
  });

  it('has no problem for a valid workflow whose agents are valid, and gives its phases', () => {
    const result = live(FLOW(['builder']));

    expect(result?.problems).toEqual([]);
    expect(result?.definition?.sequence.map((item) => item.id)).toEqual(['p0']);
  });

  it('flags a forbidden key and gives no phases', () => {
    const result = live(FLOW(['builder'], 'tools: Bash\n'));

    expect(result?.definition).toBeUndefined();
    expect(result?.problems.map((p) => [p.workflow, p.code, p.target])).toEqual([
      ['ship', 'forbidden_key', { path: 'workflows/ship/WORKFLOW.md', key: 'tools' }],
    ]);
  });

  it('flags an agent missing from the Draft, placed on the sequence line, and keeps the phases', () => {
    const result = live(FLOW(['builder', 'ghost']));

    expect(result?.definition?.sequence).toHaveLength(2);
    expect(result?.problems.map((p) => [p.code, p.target])).toEqual([
      ['phase_agent_missing', { path: 'workflows/ship/WORKFLOW.md', key: 'sequence' }],
    ]);
  });

  it('flags an agent that is invalid in the Draft', () => {
    const result = live(FLOW(['builder']), new Map([['builder', { valid: false }]]));

    expect(result?.problems.map((p) => p.code)).toEqual(['phase_agent_invalid']);
  });

  it('flags a file beside the entry file without reading it', () => {
    const result = live(FLOW(['builder']), valid('builder'), [
      entry('workflows/ship/WORKFLOW.md'),
      entry('workflows/ship/notes.txt'),
    ]);

    expect(result?.problems.map((p) => [p.code, p.target.path])).toEqual([
      ['workflow_extra_file', 'workflows/ship/notes.txt'],
    ]);
  });

  it('flags a folder left without its entry file', () => {
    const result = live(undefined, valid(), [entry('workflows/ship/notes.txt')]);

    expect(result?.problems.map((p) => p.code)).toContain('entry_missing');
  });

  it('ignores a file the Draft deleted', () => {
    const result = live(FLOW(['builder']), valid('builder'), [
      entry('workflows/ship/WORKFLOW.md'),
      entry('workflows/ship/notes.txt', { change: 'deleted' }),
    ]);

    expect(result?.problems).toEqual([]);
  });
});

describe('fromBaseWorkflow and fromDraftWorkflow', () => {
  it('place a problem at the entry file, from paths relative to the folder or the root', () => {
    const base = fromBaseWorkflow({
      name: 'ship',
      description: null,
      valid: false,
      usable: false,
      notUsableReason: null,
      problems: [
        { code: 'phase_agent_missing', path: 'WORKFLOW.md', key: 'ghost', message: 'm' },
        { code: 'entry_missing', path: '', key: null, message: 'm' },
      ],
    });
    const draft = fromDraftWorkflow({
      workflow: 'ship',
      code: 'forbidden_key',
      path: 'workflows/ship',
      key: 'tools',
      message: 'm',
    });

    expect(base.map((p) => p.target)).toEqual([
      { path: 'workflows/ship/WORKFLOW.md', key: 'sequence' },
      { path: 'workflows/ship/WORKFLOW.md' },
    ]);
    expect(draft.target).toEqual({ path: 'workflows/ship/WORKFLOW.md', key: 'tools' });
    expect(draft.workflow).toBe('ship');
  });
});

describe('agentStandings', () => {
  const agent = (name: string, problems: number): AgentSummaryOutput =>
    ({
      name,
      source: 'definitions',
      provider: 'codex',
      problems: Array.from({ length: problems }, () => ({
        code: 'key_missing',
        path: '',
        key: null,
        message: 'm',
      })),
    }) as unknown as AgentSummaryOutput;

  it('takes the Draft into account: deleted is absent, touched is judged by the API, the rest by the list', () => {
    const entries = [
      entry('agents/kept/AGENT.md'),
      entry('agents/gone/AGENT.md', { change: 'deleted' }),
      entry('agents/touched/AGENT.md', { change: 'modified' }),
      entry('agents/broken/AGENT.md', { change: 'added' }),
      entry('agents/stale/AGENT.md'),
      entry('agents/open/AGENT.md', { change: 'modified' }),
    ];

    const standings = agentStandings({
      entries,
      baseAgents: new Map([
        ['kept', agent('kept', 0)],
        ['stale', agent('stale', 1)],
      ]),
      touched: new Set(['touched', 'broken', 'open']),
      withProblems: new Set(['broken']),
      live: { agent: 'open', valid: false },
    });

    expect([...standings]).toEqual([
      ['kept', { valid: true }],
      ['touched', { valid: true }],
      ['broken', { valid: false }],
      ['stale', { valid: false }],
      ['open', { valid: false }],
    ]);
  });
});

describe('diagramItems', () => {
  it('shows each phase with the standing of its agent and the Provider of a valid base agent', () => {
    const result = live(
      FLOW(['builder', 'ghost', 'sick']),
      new Map([
        ['builder', { valid: true }],
        ['sick', { valid: false }],
      ]),
    );
    const items = diagramItems(
      result!.definition!,
      new Map([
        ['builder', { valid: true }],
        ['sick', { valid: false }],
      ]),
      new Map([['builder', { name: 'builder', provider: 'claude_code' } as AgentSummaryOutput]]),
    );

    expect(items).toEqual([
      {
        kind: 'work',
        id: 'p0',
        agent: 'builder',
        agentState: 'valid',
        provider: 'claude_code',
        usable: true,
      },
      {
        kind: 'work',
        id: 'p1',
        agent: 'ghost',
        agentState: 'missing',
        provider: null,
        usable: false,
      },
      {
        kind: 'work',
        id: 'p2',
        agent: 'sick',
        agentState: 'invalid',
        provider: null,
        usable: false,
      },
    ]);
  });
});

describe('workflowsNaming and workflowsWarning', () => {
  it('lists the base users, minus those the Draft rewrites, plus those whose Draft text names the agent', () => {
    const entries = [
      entry('workflows/changed/WORKFLOW.md', { change: 'modified' }),
      entry('workflows/removed/WORKFLOW.md', { change: 'deleted' }),
      entry('workflows/added/WORKFLOW.md', { change: 'added' }),
      entry('workflows/other/WORKFLOW.md', { change: 'added' }),
    ];
    const texts = new Map([
      ['workflows/changed/WORKFLOW.md', FLOW(['other-agent'])],
      ['workflows/added/WORKFLOW.md', FLOW(['builder'])],
      ['workflows/other/WORKFLOW.md', FLOW(['not-it'])],
    ]);

    expect(
      workflowsNaming('builder', ['changed', 'removed', 'kept', 'zed'], entries, texts),
    ).toEqual(['added', 'kept', 'zed']);
  });

  it('phrases the warning for one, several and a cut list', () => {
    expect(workflowsWarning([], false)).toBeUndefined();
    expect(workflowsWarning(['a'], false)).toBe(
      'This workflow names this agent and would become invalid: a.',
    );
    expect(workflowsWarning(['a', 'b'], true)).toBe(
      'These workflows name this agent and would become invalid: a, b and possibly more.',
    );
  });
});

describe('namedWorkflows', () => {
  const base = (name: string, key: string | null) => ({
    name,
    description: null,
    valid: false,
    usable: false,
    notUsableReason: null,
    problems: [{ code: 'phase_agent_missing' as const, path: 'WORKFLOW.md', key, message: 'm' }],
  });

  it('names the workflows the API lists for the Draft and those whose base agent problem the Draft may fix', () => {
    const named = namedWorkflows(
      [base('fixed', 'ghost'), base('still', 'other'), base('touched', 'ghost')],
      [
        { workflow: 'listed', code: 'phase_agent_missing', path: 'p', key: 'x', message: 'm' },
        { workflow: 'touched', code: 'phase_agent_missing', path: 'p', key: 'x', message: 'm' },
      ],
      new Set(['touched']),
      new Set(['ghost']),
    );

    expect([...named].sort()).toEqual(['fixed', 'listed']);
  });
});
