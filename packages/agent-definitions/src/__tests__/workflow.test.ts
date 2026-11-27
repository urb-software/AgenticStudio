import { describe, expect, it } from 'vitest';
import {
  checkWorkflowAgents,
  findAgentFolders,
  findWorkflowFolders,
  FORBIDDEN_KEYS,
  MAX_QUOTED_LENGTH,
  PROBLEM_CODES,
  SKILL_PROBLEM_CODES,
  validateAgentFolder,
  validateWorkflowFolder,
  workflowAgentNames,
  WORKFLOW_AGENT_CHECK_CODES,
  WORKFLOW_DEFAULT_SEND_BACKS,
  WORKFLOW_ENTRY_FILE,
  WORKFLOW_FORBIDDEN_KEYS,
  WORKFLOW_KNOWN_KEYS,
  WORKFLOW_MAX_ITEMS,
  WORKFLOW_PHASE_INSTRUCTIONS_MAX_BYTES,
  WORKFLOW_PROBLEM_CODES,
  WORKFLOWS_DIRECTORY,
  type WorkflowDefinition,
} from '../index.js';
import { file } from './fixtures.js';
import {
  CHECKPOINT,
  HEAD,
  REVIEW,
  sequence,
  VALID_FRONT,
  WORK,
  WORKFLOW_FAILING,
  WORKFLOW_PASSING,
  workflowFile,
} from './workflow-fixtures.js';

const summary = (problems: { code: string; path: string }[]) =>
  problems.map((problem) => `${problem.code}@${problem.path}`).sort();

const definitionOf = (front: string): WorkflowDefinition => {
  const result = validateWorkflowFolder('ship', [workflowFile(front)]);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.definition;
};

describe('failing workflow fixtures', () => {
  it.each(Object.entries(WORKFLOW_FAILING))('refuses: %s', (_name, fixture) => {
    const result = validateWorkflowFolder(fixture.folder, fixture.entries);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(summary(result.problems)).toEqual([...fixture.expected].sort());
  });

  it('has a fixture for every code the folder alone can reach', () => {
    const covered = new Set(
      Object.values(WORKFLOW_FAILING).flatMap((fixture) =>
        fixture.expected.map((item) => item.split('@')[0]),
      ),
    );
    const reachable = WORKFLOW_PROBLEM_CODES.filter(
      (code) => !(WORKFLOW_AGENT_CHECK_CODES as readonly string[]).includes(code),
    );
    expect(reachable.filter((code) => !covered.has(code))).toEqual([]);
  });

  it('keeps the codes of agents and skills as they were', () => {
    for (const code of ['workflow_extra_file', 'no_phase', 'phase_agent_missing']) {
      expect(PROBLEM_CODES as readonly string[]).not.toContain(code);
      expect(SKILL_PROBLEM_CODES as readonly string[]).not.toContain(code);
    }
    expect(WORKFLOW_PROBLEM_CODES).not.toContain('provider_unknown');
    expect(WORKFLOW_PROBLEM_CODES).not.toContain('model_unknown');
  });

  it('never says "step", "agent definition" or AGENT.md in the wording of a message', () => {
    const messages = Object.values(WORKFLOW_FAILING).flatMap((fixture) => {
      const result = validateWorkflowFolder(fixture.folder, fixture.entries);
      return result.ok ? [] : result.problems.map((item) => item.message);
    });
    expect(messages.length).toBeGreaterThan(60);
    const wording = messages.map((message) => message.replace(/"[^"]*"/g, ''));
    expect(wording.filter((message) => /step|AGENT\.md/i.test(message))).toEqual([]);
  });

  it('quotes at most a key, an id or a path, never a value', () => {
    const long = `a${'x'.repeat(100)}`;
    const result = validateWorkflowFolder('ship', [
      workflowFile(
        `${HEAD}\ncolour: secret-value-123\n${sequence(
          WORK,
          `  - id: ask\n    kind: checkpoint\n    text: secret-text-456\n    ${long}: x`,
          REVIEW,
        )}`,
      ),
      file(`${long}.txt`, 'x'),
    ]);
    if (result.ok) throw new Error('accepted');
    for (const item of result.problems) {
      expect(item.message).not.toContain('secret-value-123');
      expect(item.message).not.toContain('secret-text-456');
      expect(item.message).not.toContain(long);
      expect((item.key ?? '').length).toBeLessThanOrEqual(MAX_QUOTED_LENGTH);
    }
    const unknown = result.problems.filter((item) => item.code === 'unknown_key');
    expect(unknown.map((item) => item.key)).toEqual(['colour', 'ask']);
  });

  it('names the item id of an item problem', () => {
    const result = validateWorkflowFolder('ship', [
      workflowFile(`${HEAD}\n${sequence(`${WORK}\n    colour: red`)}`),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ code: 'unknown_key', key: 'build' });
    expect(result.problems[0]?.message).toContain('"build"');
  });
});

describe('passing workflow fixtures', () => {
  it.each(Object.entries(WORKFLOW_PASSING))('accepts a workflow with %s', (_name, fixture) => {
    const result = validateWorkflowFolder(fixture.folder, fixture.entries);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.definition).toMatchObject(fixture.definition);
    expect(result.definition.files.map((item) => item.path)).toEqual(
      fixture.entries.filter((item) => item.kind === 'file').map((item) => item.path),
    );
  });

  it('accepts CRLF line endings', () => {
    const crlf = file(
      'WORKFLOW.md',
      `---\r\n${VALID_FRONT.replaceAll('\n', '\r\n')}\r\n---\r\nBody\r\n`,
    );
    expect(validateWorkflowFolder('ship', [crlf]).ok).toBe(true);
  });

  it('omits the instructions a phase does not set', () => {
    const [first] = definitionOf(VALID_FRONT).sequence;
    expect(Object.keys(first ?? {}).sort()).toEqual(['agent', 'id', 'kind']);
  });
});

describe('the format constants', () => {
  it('name the folder, the entry file and the keys', () => {
    expect(WORKFLOWS_DIRECTORY).toBe('workflows');
    expect(WORKFLOW_ENTRY_FILE).toBe('WORKFLOW.md');
    expect([...WORKFLOW_KNOWN_KEYS].sort()).toEqual(
      ['description', 'name', 'send-backs', 'sequence'].sort(),
    );
    expect(WORKFLOW_DEFAULT_SEND_BACKS).toBe(2);
    expect(WORKFLOW_MAX_ITEMS).toBe(12);
  });

  it('forbid what a workflow must not configure, besides what agents forbid', () => {
    expect([...WORKFLOW_FORBIDDEN_KEYS].sort()).toEqual(
      [
        'command',
        'commands',
        'env',
        'limits',
        'max-steps',
        'model',
        'provider',
        'run',
        'script',
        'skills',
        'step-minutes',
        'timeout',
      ].sort(),
    );
    for (const key of WORKFLOW_FORBIDDEN_KEYS) expect(FORBIDDEN_KEYS).not.toContain(key);
  });

  it.each([...FORBIDDEN_KEYS, 'ALLOWED_TOOLS'])('%s is forbidden for a workflow', (key) => {
    const result = validateWorkflowFolder('ship', [workflowFile(`${VALID_FRONT}\n${key}: x`)]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems.map((item) => item.code)).toEqual(['forbidden_key']);
  });

  it.each([...WORKFLOW_FORBIDDEN_KEYS, 'MAX_STEPS', 'Step-Minutes'])(
    '%s is refused for a workflow with its own reason, at the top and in an item',
    (key) => {
      for (const front of [
        `${VALID_FRONT}\n${key}: x`,
        `${HEAD}\n${sequence(`${WORK}\n    ${key}: x`)}`,
      ]) {
        const result = validateWorkflowFolder('ship', [workflowFile(front)]);
        if (result.ok) throw new Error('accepted');
        expect(result.problems.map((item) => item.code)).toEqual(['workflow_forbidden_key']);
      }
    },
  );
});

describe('phase instructions', () => {
  it('are bounded at 2 KiB, which fits the front matter they live in', () => {
    expect(WORKFLOW_PHASE_INSTRUCTIONS_MAX_BYTES).toBe(2048);
  });
});

describe('item problems', () => {
  it('quote each offending key, so two bad keys give two distinct messages', () => {
    const result = validateWorkflowFolder('ship', [
      workflowFile(`${HEAD}
${sequence(`${WORK}
    colour: a
    size: b
    model: c`)}`),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems.map((item) => [item.code, item.key])).toEqual([
      ['unknown_key', 'build'],
      ['unknown_key', 'build'],
      ['workflow_forbidden_key', 'build'],
    ]);
    const messages = result.problems.map((item) => item.message);
    expect(new Set(messages).size).toBe(3);
    expect(messages[0]).toContain('"colour"');
    expect(messages[1]).toContain('"size"');
    expect(messages[2]).toContain('"model"');
    expect(messages.every((message) => message.includes('"build"'))).toBe(true);
  });

  it('shorten a long offending key', () => {
    const long = `k${'x'.repeat(100)}`;
    const result = validateWorkflowFolder('ship', [
      workflowFile(`${HEAD}
${sequence(`${WORK}
    ${long}: a`)}`),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems[0]?.message).not.toContain(long);
    expect(result.problems[0]?.message).toContain(`${long.slice(0, MAX_QUOTED_LENGTH)}...`);
  });

  it('call the Markdown body documentation when it is too large', () => {
    const result = validateWorkflowFolder('ship', [
      workflowFile(VALID_FRONT, 'x'.repeat(64 * 1024 + 1)),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems[0]?.message).toContain('documentation');
  });

  it('name the reserved agent a phase names', () => {
    const result = validateWorkflowFolder('ship', [
      workflowFile(
        `${HEAD}\n${sequence('  - id: build', '    kind: work', '    agent: definitions-repository')}`,
      ),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems[0]).toMatchObject({ code: 'phase_agent_reserved', key: 'build' });
    expect(result.problems[0]?.message).toContain('"definitions-repository"');
  });
});

describe('the send-back limit', () => {
  it('defaults to two and keeps a lower value', () => {
    expect(definitionOf(VALID_FRONT).sendBacks).toBe(2);
    expect(definitionOf(`${VALID_FRONT}\nsend-backs: 1`).sendBacks).toBe(1);
    expect(definitionOf(`${VALID_FRONT}\nsend-backs: 2`).sendBacks).toBe(2);
  });
});

describe('the order of items', () => {
  const codes = (...items: string[]): string[] => {
    const result = validateWorkflowFolder('ship', [workflowFile(`${HEAD}\n${sequence(...items)}`)]);
    return result.ok ? [] : result.problems.map((item) => item.code).sort();
  };
  const w = (id: string) => `  - id: ${id}\n    kind: work\n    agent: a`;
  const r = (id: string) => `  - id: ${id}\n    kind: review\n    agent: a`;
  const c = (id: string) => `  - id: ${id}\n    kind: checkpoint\n    text: t`;

  it('accepts several reviews and checkpoints between phases', () => {
    expect(codes(w('a'), r('b'), c('c'), w('d'), r('e'))).toEqual([]);
    expect(codes(w('a'), c('b'), r('c'))).toEqual([]);
  });

  it('reports a sequence of checkpoints only without a phase, first and last', () => {
    expect(codes(c('a'))).toEqual(['checkpoint_first', 'checkpoint_last', 'no_phase']);
  });

  it('reports adjacent checkpoints once', () => {
    expect(codes(w('a'), c('b'), c('c'), c('d'), r('e'))).toEqual(['checkpoints_adjacent']);
  });

  it('reports a duplicate id once, however often it repeats', () => {
    expect(codes(w('a'), w('a'), w('a'))).toEqual(['item_id_duplicate']);
  });

  it('judges no order when there are too many items', () => {
    const items = Array.from({ length: 13 }, (_, index) => c(`c${index}`));
    expect(codes(...items)).toEqual(['sequence_too_long']);
  });
});

describe('findWorkflowFolders', () => {
  const at = (prefix: string, entry: ReturnType<typeof file>) => ({
    ...entry,
    path: `${prefix}${entry.path}`,
  });

  it('groups the entries of each workflows/<name>/ folder, with paths relative to it', () => {
    const folders = findWorkflowFolders([
      at('workflows/ship/', workflowFile(VALID_FRONT)),
      at('workflows/ship/', file('notes.md', 'x')),
      at('workflows/other/', workflowFile(VALID_FRONT)),
    ]);
    expect(folders.map((folder) => folder.name).sort()).toEqual(['other', 'ship']);
    const ship = folders.find((folder) => folder.name === 'ship');
    expect(ship?.entries.map((entry) => entry.path)).toEqual(['WORKFLOW.md', 'notes.md']);
  });

  it('ignores agents/, skills/, the top level and loose files directly under workflows/', () => {
    const folders = findWorkflowFolders([
      file('README.md', 'x'),
      at('agents/reviewer/', file('AGENT.md', 'x')),
      at('skills/helper/', file('SKILL.md', 'x')),
      file('workflows/README.md', 'x'),
      { path: 'workflows', kind: 'directory', size: 0 },
      { path: 'docs/workflows/x/WORKFLOW.md', kind: 'file', size: 1 },
      at('workflows/ship/', workflowFile(VALID_FRONT)),
    ]);
    expect(folders.map((folder) => folder.name)).toEqual(['ship']);
  });

  it('keeps a folder that is itself a symbolic link, so validation refuses it', () => {
    const folders = findWorkflowFolders([{ path: 'workflows/evil', kind: 'symlink', size: 3 }]);
    expect(folders.map((folder) => folder.name)).toEqual(['evil']);
    expect(validateWorkflowFolder('evil', folders[0]?.entries ?? []).ok).toBe(false);
  });

  it('leaves findAgentFolders looking only under agents/', () => {
    expect(findAgentFolders([at('workflows/ship/', workflowFile(VALID_FRONT))])).toEqual([]);
  });
});

describe('checkWorkflowAgents', () => {
  const workflow = definitionOf(
    `${HEAD}\n${sequence(
      WORK,
      CHECKPOINT,
      '  - id: fix\n    kind: work\n    agent: gone',
      '  - id: check\n    kind: review\n    agent: reviewer',
      '  - id: again\n    kind: review\n    agent: bad',
    )}`,
  );
  const agents = new Map([
    ['implementer', { valid: true }],
    ['reviewer', { valid: true }],
    ['bad', { valid: false }],
  ]);

  it('reports a missing and an invalid agent, each with the Phase id and the agent', () => {
    const problems = checkWorkflowAgents(workflow, agents);
    expect(problems.map((item) => [item.code, item.key])).toEqual([
      ['phase_agent_missing', 'gone'],
      ['phase_agent_invalid', 'bad'],
    ]);
    expect(problems.every((item) => item.path === 'WORKFLOW.md')).toBe(true);
    expect(problems.map((item) => item.message)).toEqual([
      'The phase "fix" names the agent "gone", which does not exist.',
      'The phase "again" names the agent "bad", which is not valid.',
    ]);
  });

  it('finds nothing when every agent is valid, and ignores checkpoints', () => {
    const fine = definitionOf(`${HEAD}\n${sequence(WORK, CHECKPOINT, REVIEW)}`);
    expect(checkWorkflowAgents(fine, agents)).toEqual([]);
  });

  it('compares names exactly and reports a phase once per phase', () => {
    const problems = checkWorkflowAgents(
      definitionOf(
        `${HEAD}\n${sequence(WORK, '  - id: two\n    kind: work\n    agent: implementer')}`,
      ),
      new Map([['Implementer', { valid: true }]]),
    );
    expect(problems.map((item) => item.code)).toEqual([
      'phase_agent_missing',
      'phase_agent_missing',
    ]);
  });

  it('quotes the agent name shortened', () => {
    const long = `a${'x'.repeat(100)}`;
    const named = { sequence: [{ id: 'build', kind: 'work' as const, agent: long }] };
    const [item] = checkWorkflowAgents(named, new Map());
    expect(item?.key).toBe(long.slice(0, MAX_QUOTED_LENGTH));
    expect(item?.message).not.toContain(long);
  });

  it('judges an agent against the same commit through validateAgentFolder', () => {
    const agent = validateAgentFolder('implementer', [
      file(
        'AGENT.md',
        '---\nname: implementer\ndescription: Builds\nprovider: claude_code\n---\nDo it.\n',
      ),
    ]);
    const map = new Map([['implementer', { valid: agent.ok }]]);
    expect(checkWorkflowAgents(definitionOf(`${HEAD}\n${sequence(WORK)}`), map)).toEqual([]);
  });

  it('has a code for each reason, both in WORKFLOW_PROBLEM_CODES', () => {
    expect([...WORKFLOW_AGENT_CHECK_CODES].sort()).toEqual([
      'phase_agent_invalid',
      'phase_agent_missing',
    ]);
    for (const code of WORKFLOW_AGENT_CHECK_CODES) expect(WORKFLOW_PROBLEM_CODES).toContain(code);
  });
});

describe('workflowAgentNames', () => {
  const text = (front: string) => workflowFile(front).content as string;

  it('lists the agents of the phases in order, skipping checkpoints, whether or not valid', () => {
    expect(workflowAgentNames(text(`${HEAD}\n${sequence(WORK, CHECKPOINT, REVIEW)}`))).toEqual([
      'implementer',
      'reviewer',
    ]);
    expect(workflowAgentNames(text(`${HEAD}\nunknown: 1\n${sequence(REVIEW)}`))).toEqual([
      'reviewer',
    ]);
  });

  it('is empty when the front matter or the sequence cannot be read', () => {
    expect(workflowAgentNames('no front matter')).toEqual([]);
    expect(workflowAgentNames('---\nname: [x\n---\n')).toEqual([]);
    expect(workflowAgentNames(text(HEAD))).toEqual([]);
    expect(workflowAgentNames(text(`${HEAD}\nsequence: nope`))).toEqual([]);
  });

  it('ignores an item that names no text agent', () => {
    const odd = '  - id: x\n    kind: work\n    agent: 5';
    expect(workflowAgentNames(text(`${HEAD}\n${sequence(odd, WORK)}`))).toEqual(['implementer']);
  });
});
