import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_KEYS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FOLDER_BYTES,
  MAX_INSTRUCTIONS_BYTES,
  AGENT_SKILL_CHECK_CODES,
  PROBLEM_CODES,
  validateAgentFolder,
} from '../index.js';
import { entryFile, FAILING, file, PASSING, VALID_FRONT } from './fixtures.js';

const summary = (problems: { code: string; path: string }[]) =>
  problems.map((problem) => `${problem.code}@${problem.path}`).sort();

describe('failing fixtures', () => {
  it.each(Object.entries(FAILING))('refuses: %s', (_name, fixture) => {
    const result = validateAgentFolder(fixture.folder, fixture.entries);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(summary(result.problems)).toEqual([...fixture.expected].sort());
  });

  it('has a fixture for every refusal code', () => {
    const covered = new Set(
      Object.values(FAILING).flatMap((fixture) =>
        fixture.expected.map((item) => item.split('@')[0]),
      ),
    );
    // The two skill cross-check reasons are judged by checkAgentSkills, not by the folder.
    const folderCodes = PROBLEM_CODES.filter(
      (code) => !AGENT_SKILL_CHECK_CODES.some((c) => c === code),
    );
    expect(folderCodes.filter((code) => !covered.has(code))).toEqual([]);
  });

  it('reports the offending key on key problems', () => {
    const result = validateAgentFolder('reviewer', [
      entryFile(`${VALID_FRONT}\nhooks: x\ncolour: red`),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems.map((problem) => [problem.code, problem.key])).toEqual([
      ['forbidden_key', 'hooks'],
      ['unknown_key', 'colour'],
    ]);
  });
});

describe('passing fixtures', () => {
  it.each(Object.entries(PASSING))('accepts an agent with %s', (_name, fixture) => {
    const result = validateAgentFolder(fixture.folder, fixture.entries);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.definition).toMatchObject(fixture.definition);
    expect(result.definition.files.map((item) => item.path)).toEqual(
      fixture.entries.filter((item) => item.kind === 'file').map((item) => item.path),
    );
  });

  it('accepts the model default and every listed model', () => {
    for (const model of ['default', 'opus', 'sonnet', 'haiku']) {
      const result = validateAgentFolder('reviewer', [
        entryFile(`${VALID_FRONT}\nmodel: ${model}`),
      ]);
      expect(result.ok).toBe(true);
    }
  });

  it('accepts CRLF line endings and the limits exactly', () => {
    const crlf = file(
      'AGENT.md',
      `---\r\n${VALID_FRONT.replaceAll('\n', '\r\n')}\r\n---\r\nBody\r\n`,
    );
    expect(validateAgentFolder('reviewer', [crlf]).ok).toBe(true);
    expect(
      validateAgentFolder('reviewer', [entryFile(VALID_FRONT, 'x'.repeat(MAX_INSTRUCTIONS_BYTES))])
        .ok,
    ).toBe(true);
    const many = Array.from({ length: MAX_FILES - 1 }, (_, index) => file(`s/${index}`, 'x'));
    expect(validateAgentFolder('reviewer', [entryFile(VALID_FRONT), ...many]).ok).toBe(true);
    expect(
      validateAgentFolder('reviewer', [
        entryFile(VALID_FRONT),
        { path: 'a.bin', kind: 'file', size: MAX_FILE_BYTES },
      ]).ok,
    ).toBe(true);
  });

  it('measures instructions in UTF-8 bytes', () => {
    const result = validateAgentFolder('reviewer', [
      entryFile(VALID_FRONT, 'é'.repeat(MAX_INSTRUCTIONS_BYTES / 2 + 1)),
    ]);
    expect(result.ok).toBe(false);
  });
});

describe('forbidden keys', () => {
  const spellings = [
    ...FORBIDDEN_KEYS,
    'ALLOWED_TOOLS',
    'Allowed-Tools',
    'allowed_tools',
    'permission_mode',
    'Permission-Mode',
    'MCP_Servers',
    'disallowed_tools',
  ];

  it.each(spellings)('%s is forbidden, not unknown', (key) => {
    const result = validateAgentFolder('reviewer', [entryFile(`${VALID_FRONT}\n${key}: x`)]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems.map((problem) => problem.code)).toEqual(['forbidden_key']);
    expect(result.problems[0]?.key).toBe(key);
  });

  it('lists every key the decision names', () => {
    expect([...FORBIDDEN_KEYS].sort()).toEqual(
      [
        'tools',
        'allowed-tools',
        'allowedTools',
        'disallowedTools',
        'disallowed-tools',
        'permissions',
        'permissionMode',
        'permission-mode',
        'hooks',
        'mcpServers',
        'mcp-servers',
        'mcp',
        'memory',
        'isolation',
      ].sort(),
    );
  });
});

describe('limits are exported', () => {
  it('has the documented values', () => {
    expect(MAX_INSTRUCTIONS_BYTES).toBe(64 * 1024);
    expect(MAX_FILES).toBe(100);
    expect(MAX_FILE_BYTES).toBe(1024 * 1024);
    expect(MAX_FOLDER_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('messages never carry content', () => {
  const SECRET = 'sk-fake-0123456789-not-a-real-token';

  it('quotes no value of a refused key', () => {
    const result = validateAgentFolder('reviewer', [
      entryFile(
        `${VALID_FRONT}\ntools: ${SECRET}\nallowedTools: ${SECRET}\ncolour: ${SECRET}\nmodel: ${SECRET}`,
      ),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems.length).toBe(4);
    expect(JSON.stringify(result.problems)).not.toContain(SECRET);
  });

  it('quotes no value of a wrong provider, name or description', () => {
    const result = validateAgentFolder('reviewer', [
      entryFile(`name: ${SECRET}\ndescription: [${SECRET}]\nprovider: ${SECRET}`),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(JSON.stringify(result.problems)).not.toContain(SECRET);
  });

  it('quotes no file content when the front matter is malformed', () => {
    const result = validateAgentFolder('reviewer', [entryFile(`name: [${SECRET}`)]);
    if (result.ok) throw new Error('accepted');
    expect(JSON.stringify(result.problems)).not.toContain(SECRET);
  });

  it('truncates a very long key', () => {
    const key = `k${'x'.repeat(500)}`;
    const result = validateAgentFolder('reviewer', [entryFile(`${VALID_FRONT}\n${key}: 1`)]);
    if (result.ok) throw new Error('accepted');
    expect(JSON.stringify(result.problems).length).toBeLessThan(600);
  });
});

describe('a refusal always has a reason', () => {
  it('gives at least one problem for every failing fixture', () => {
    for (const fixture of Object.values(FAILING)) {
      const result = validateAgentFolder(fixture.folder, fixture.entries);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.length).toBeGreaterThan(0);
    }
  });

  it('gives a reason when AGENT.md is only a directory or the folder is empty', () => {
    for (const entries of [[], [{ path: 'AGENT.md', kind: 'directory', size: 0 }]]) {
      const result = validateAgentFolder('reviewer', entries);
      if (result.ok) throw new Error('accepted');
      expect(result.problems.map((problem) => problem.code)).toEqual(['entry_missing']);
    }
  });
});

describe('sizes', () => {
  it('measures the entry file by its content when it is larger than the declared size', () => {
    const entry = {
      path: 'AGENT.md',
      kind: 'file',
      size: 0,
      content: `---\n${VALID_FRONT}\n---\n${'x'.repeat(MAX_FILE_BYTES)}`,
    };
    const result = validateAgentFolder('reviewer', [entry]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems.map((problem) => problem.code).sort()).toEqual([
      'file_too_large',
      'instructions_too_large',
    ]);
  });

  it('does not let a negative size lower the total', () => {
    const result = validateAgentFolder('reviewer', [
      entryFile(VALID_FRONT),
      ...Array.from({ length: 6 }, (_, index) => ({
        path: `p${index}.bin`,
        kind: 'file',
        size: MAX_FILE_BYTES,
      })),
      { path: 'neg.bin', kind: 'file', size: -1e9 },
    ]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems.map((problem) => problem.code).sort()).toEqual([
      'folder_too_large',
      'size_invalid',
    ]);
  });
});

describe('purity', () => {
  it('does not mutate its input', () => {
    const entries = [entryFile(VALID_FRONT)];
    const copy = structuredClone(entries);
    validateAgentFolder('reviewer', entries);
    expect(entries).toEqual(copy);
  });
});
