import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../../domain/entities/project.js';
import {
  ProjectNameTakenError,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  InvalidProjectNameError,
  normalizeProjectName,
  type ProjectName,
} from '../../../domain/value-objects/project-name.js';
import { CreateProjectHandler } from '../handler.js';

/** In-memory adapter of the repository port, with the same uniqueness rule as the database. */
class InMemoryProjectRepository implements ProjectRepository {
  readonly stored: { name: string; uniquenessKey: string }[] = [];

  add(name: ProjectName): Promise<Project> {
    if (this.stored.some((project) => project.uniquenessKey === name.uniquenessKey)) {
      return Promise.reject(new ProjectNameTakenError());
    }
    this.stored.push({ name: name.value, uniquenessKey: name.uniquenessKey });
    return Promise.resolve({
      id: `id-${this.stored.length}`,
      name: name.value,
      createdAt: new Date('2026-11-12T10:00:00.000Z'),
    });
  }

  listNewestFirst(): Promise<Project[]> {
    return Promise.reject(new Error('not used by create-project'));
  }
}

// The same vector is checked against the web form's normalizeForHint
// (apps/web/.../create-project/__tests__/normalize-for-hint.test.ts), so the copies cannot drift.
const VECTOR = resolve(process.cwd(), '../../tests/fixtures/project-name-normalization.json');
const { cases: NORMALIZATION_CASES } = JSON.parse(readFileSync(VECTOR, 'utf8')) as {
  cases: { name: string; input: string; expected: string }[];
};

describe('normalizeProjectName: shared project-name normalization vector', () => {
  it.each(NORMALIZATION_CASES.map((c) => [c.name, c.input, c.expected] as const))(
    '%s',
    (_name, input, expected) => {
      expect(normalizeProjectName(input)).toBe(expected);
    },
  );
});

function setUp() {
  const projects = new InMemoryProjectRepository();
  return { projects, handler: new CreateProjectHandler(projects) };
}

describe('CreateProjectHandler: project name normalization', () => {
  it.each([
    ['surrounding whitespace', '  Agentic Studio  ', 'Agentic Studio'],
    ['internal whitespace runs', 'Agentic \t\n  Studio', 'Agentic Studio'],
    ['non-ASCII whitespace', ' Agentic Studio　', 'Agentic Studio'],
    ['an already normalized name', 'Agentic Studio', 'Agentic Studio'],
  ])('trims and collapses %s, keeping case', async (_case, raw, expected) => {
    const { handler, projects } = setUp();

    const project = await handler.execute({ name: raw });

    expect(project.name).toBe(expected);
    expect(projects.stored[0]?.name).toBe(expected);
  });

  it.each([
    ['ASCII', 'Agentic STUDIO', 'agentic studio'],
    ['beyond ASCII', 'ÄRGER Über ÖL', 'ärger über öl'],
    ['Greek', 'ΣΟΦΊΑ', 'σοφία'],
  ])('derives the uniqueness key by lower-casing (%s)', async (_case, raw, key) => {
    const { handler, projects } = setUp();

    await handler.execute({ name: raw });

    expect(projects.stored[0]?.uniquenessKey).toBe(key);
  });

  it('measures the length after normalization: 100 characters pass', async () => {
    const { handler } = setUp();

    const project = await handler.execute({ name: `  ${'a'.repeat(50)}    ${'b'.repeat(49)}  ` });

    expect(project.name).toHaveLength(100);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', ' \t\n  '],
  ])('rejects a name that is %s after trimming', async (_case, raw) => {
    const { handler, projects } = setUp();

    await expect(handler.execute({ name: raw })).rejects.toEqual(
      new InvalidProjectNameError('empty'),
    );
    expect(projects.stored).toEqual([]);
  });

  it('rejects a name over 100 characters after normalization', async () => {
    const { handler, projects } = setUp();

    await expect(handler.execute({ name: `${'a'.repeat(50)}  ${'b'.repeat(50)}` })).rejects.toEqual(
      new InvalidProjectNameError('too-long'),
    );
    expect(projects.stored).toEqual([]);
  });

  it('stores the name in Unicode NFC (Issue #30 decision 1)', async () => {
    const { handler, projects } = setUp();
    const nfd = 'Cafe\u0301 Ore\u0301'; // e + combining acute accent

    const project = await handler.execute({ name: nfd });

    expect(project.name).toBe('Caf\u00e9 Or\u00e9');
    expect(projects.stored[0]).toEqual({
      name: 'Caf\u00e9 Or\u00e9',
      uniquenessKey: 'caf\u00e9 or\u00e9',
    });
  });

  it('treats the NFC and NFD spellings of a name as the same name', async () => {
    const { handler } = setUp();
    await handler.execute({ name: 'Caf\u00e9' });

    await expect(handler.execute({ name: 'CAFE\u0301' })).rejects.toBeInstanceOf(
      ProjectNameTakenError,
    );
  });

  it('counts the length in code points: 100 astral characters pass', async () => {
    const { handler } = setUp();
    const name = '\u{1F600}'.repeat(100); // 100 code points, 200 UTF-16 code units

    const project = await handler.execute({ name });

    expect(project.name).toBe(name);
  });

  it('counts the length in code points: 101 astral characters are too long', async () => {
    const { handler, projects } = setUp();

    await expect(handler.execute({ name: '\u{1F600}'.repeat(101) })).rejects.toEqual(
      new InvalidProjectNameError('too-long'),
    );
    expect(projects.stored).toEqual([]);
  });

  it('measures the length after NFC: 100 characters written in NFD pass', async () => {
    const { handler } = setUp();

    const project = await handler.execute({ name: 'e\u0301'.repeat(100) });

    expect(project.name).toBe('\u00e9'.repeat(100));
  });

  it('normalizes to NFC before trimming: an NFD name in surrounding whitespace collides', async () => {
    const { handler } = setUp();
    await handler.execute({ name: 'Caf\u00e9' });

    await expect(handler.execute({ name: '\u3000 cafe\u0301 \u2001' })).rejects.toBeInstanceOf(
      ProjectNameTakenError,
    );
  });

  it('measures the length after NFC: 101 characters written in NFD are too long', async () => {
    const { handler } = setUp();

    await expect(handler.execute({ name: 'e\u0301'.repeat(101) })).rejects.toEqual(
      new InvalidProjectNameError('too-long'),
    );
  });

  it('reports a name taken by another project after normalization', async () => {
    const { handler } = setUp();
    await handler.execute({ name: 'Agentic Studio' });

    await expect(handler.execute({ name: '  agentic   STUDIO ' })).rejects.toBeInstanceOf(
      ProjectNameTakenError,
    );
  });
});
