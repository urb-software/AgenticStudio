import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_SERVICES,
  MAX_TEXT_BYTES,
  REFUSAL_CODES,
  validateCompose,
  type ComposeResult,
  type RefusalCode,
} from '../index.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');

interface Fixture {
  name: string;
  text: string;
  entryService: string;
  entryPort: number;
  /** For a refused fixture: the code in its file name, and the place a comment may name. */
  code?: RefusalCode;
  place?: string;
}

function load(dir: 'accepted' | 'refused'): Fixture[] {
  return readdirSync(join(FIXTURES, dir))
    .filter((file) => file.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const text = readFileSync(join(FIXTURES, dir, file), 'utf8');
      const entry = /^# entry: (\S+) (\S+)$/m.exec(text);
      const place = /^# place: (\S+)$/m.exec(text)?.[1];
      const code = dir === 'refused' ? (file.split('--')[0] as RefusalCode) : undefined;
      return {
        name: file.replace(/\.yaml$/, ''),
        text,
        entryService: entry?.[1] ?? 'web',
        entryPort: Number(entry?.[2] ?? 8080),
        code,
        place,
      };
    });
}

const run = (fixture: Fixture): ComposeResult =>
  validateCompose({
    text: fixture.text,
    entryService: fixture.entryService,
    entryPort: fixture.entryPort,
  });

const input = (text: string, entryService = 'web', entryPort = 8080) => ({
  text,
  entryService,
  entryPort,
});

function refusalsOf(result: ComposeResult) {
  if (result.status !== 'refused') throw new Error('expected a refusal');
  return result.refusals;
}

describe('accepted fixtures', () => {
  for (const fixture of load('accepted')) {
    it(`accepts ${fixture.name}`, () => {
      const result = run(fixture);
      expect(result.status === 'refused' ? result.refusals : []).toEqual([]);
      expect(result.status).toBe('accepted');
    });
  }
});

describe('refused fixtures', () => {
  const fixtures = load('refused');

  for (const fixture of fixtures) {
    it(`refuses ${fixture.name} with ${fixture.code}`, () => {
      const refusals = refusalsOf(run(fixture));
      const codes = refusals.map((refusal) => refusal.code);
      expect(codes).toContain(fixture.code);
      if (fixture.place) {
        expect(
          refusals.filter((refusal) => refusal.code === fixture.code).map((r) => r.place),
        ).toContain(fixture.place);
      }
      for (const refusal of refusals) {
        expect(refusal.place.length).toBeGreaterThan(0);
        expect(refusal.message.length).toBeGreaterThan(0);
      }
    });
  }

  // Codes with no file fixture because the input cannot sensibly be a file in the repository.
  const generated: Partial<Record<RefusalCode, ComposeResult>> = {
    text_too_large: validateCompose(
      input(`services:\n  web:\n    image: x\n# ${'a'.repeat(MAX_TEXT_BYTES)}\n`),
    ),
    unjudgeable: validateCompose({
      text: 42 as unknown as string,
      entryService: 'web',
      entryPort: 8080,
    }),
  };

  it('has a failing fixture for every refusal code', () => {
    const covered = new Set<RefusalCode>([
      ...fixtures.map((fixture) => fixture.code as RefusalCode),
      ...(Object.keys(generated) as RefusalCode[]),
    ]);
    expect(REFUSAL_CODES.filter((code) => !covered.has(code))).toEqual([]);
  });

  it('refuses the generated cases with their codes', () => {
    for (const [code, result] of Object.entries(generated)) {
      expect(refusalsOf(result).map((refusal) => refusal.code)).toContain(code);
    }
  });

  it('only uses refusal codes it knows', () => {
    for (const fixture of fixtures) {
      expect(REFUSAL_CODES).toContain(fixture.code);
    }
  });
});

describe('limits', () => {
  it('accepts a file of exactly the size limit', () => {
    const base = 'services:\n  web:\n    image: x\n#';
    const text = base + 'a'.repeat(MAX_TEXT_BYTES - base.length);
    expect(text.length).toBe(MAX_TEXT_BYTES);
    expect(validateCompose(input(text)).status).toBe('accepted');
  });

  it('measures the size in bytes, not characters', () => {
    const base = 'services:\n  web:\n    image: x\n#';
    const text = base + 'é'.repeat(MAX_TEXT_BYTES / 2);
    expect(refusalsOf(validateCompose(input(text))).map((r) => r.code)).toEqual(['text_too_large']);
  });

  it('accepts as many services as the limit and refuses one more', () => {
    const make = (count: number) =>
      'services:\n' +
      Array.from(
        { length: count },
        (_, i) => `  ${i === 0 ? 'web' : `s${i}`}:\n    image: x\n`,
      ).join('');
    expect(validateCompose(input(make(MAX_SERVICES))).status).toBe('accepted');
    expect(refusalsOf(validateCompose(input(make(MAX_SERVICES + 1)))).map((r) => r.code)).toContain(
      'too_many_services',
    );
  });

  it('refuses, and does not throw, on a document nested far deeper than any stack', () => {
    for (const text of ['['.repeat(100_000), `a: ${'['.repeat(100_000)}`, '{a:'.repeat(50_000)]) {
      expect(validateCompose(input(text)).status).toBe('refused');
    }
  });
});

describe('what an accepted result carries', () => {
  it('removes published ports and says where they were', () => {
    const result = validateCompose(
      input(
        'services:\n  web:\n    image: x\n    ports:\n      - "8080:80"\n      - target: 443\n        published: 8443\n  db:\n    image: y\n    expose: ["5432"]\n',
      ),
    );
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(result.removedPorts).toEqual([
      { service: 'web', place: 'services.web.ports[0]' },
      { service: 'web', place: 'services.web.ports[1]' },
    ]);
    const services = result.stack.services as Record<string, Record<string, unknown>>;
    expect(services.web).not.toHaveProperty('ports');
    expect(services.db?.expose).toEqual(['5432']);
  });

  it('reports no removed ports when there were none', () => {
    const result = validateCompose(input('services:\n  web:\n    image: x\n'));
    expect(result).toEqual({
      status: 'accepted',
      stack: { services: { web: { image: 'x' } } },
      removedPorts: [],
    });
  });

  it('resolves anchors and merge keys in the stack, and drops x- fields', () => {
    const result = validateCompose(
      input('x-c: &c\n  restart: always\nservices:\n  web:\n    <<: *c\n    image: x\n'),
    );
    expect(result).toEqual({
      status: 'accepted',
      stack: { services: { web: { restart: 'always', image: 'x' } } },
      removedPorts: [],
    });
  });

  it('lets an explicit key win over a merged one, as Compose does', () => {
    const result = validateCompose(
      input(
        'x-c: &c\n  privileged: true\nservices:\n  web:\n    <<: *c\n    image: x\n    privileged: false\n',
      ),
    );
    expect(result.status).toBe('accepted');
  });

  it('returns a stack that serialises to JSON', () => {
    const result = validateCompose(input('services:\n  web:\n    image: x\n'));
    if (result.status !== 'accepted') throw new Error('expected accepted');
    expect(JSON.parse(JSON.stringify(result.stack))).toEqual(result.stack);
  });
});

describe('places and lines', () => {
  it('names the place and the line of a refusal', () => {
    const text =
      'services:\n  web:\n    image: x\n    volumes:\n      - data:/d\n      - /etc:/e\nvolumes:\n  data:\n';
    expect(refusalsOf(validateCompose(input(text)))).toEqual([
      {
        code: 'mount_outside_source',
        place: 'services.web.volumes[1]',
        line: 6,
        message: expect.any(String),
      },
    ]);
  });

  it('gives a parser error its line', () => {
    const refusals = refusalsOf(
      validateCompose(input('services:\n  web:\n    image: a\n    image: b\n')),
    );
    expect(refusals[0]).toMatchObject({ code: 'duplicate_key', line: 4 });
  });

  it('falls back to the nearest line for content that came from a merge key', () => {
    const refusals = refusalsOf(
      validateCompose(
        input('x-b: &b\n  privileged: true\nservices:\n  web:\n    <<: *b\n    image: x\n'),
      ),
    );
    expect(refusals[0]).toMatchObject({ code: 'privileged', place: 'services.web.privileged' });
    expect(refusals[0]?.line).toBeGreaterThan(0);
  });

  it('reports every problem of a file, not only the first', () => {
    const refusals = refusalsOf(
      validateCompose(
        input(
          'services:\n  web:\n    image: x\n    privileged: true\n    cap_add: [ALL]\n    network_mode: host\n',
        ),
      ),
    );
    expect(refusals.map((r) => r.code).sort()).toEqual([
      'capability_added',
      'host_namespace',
      'privileged',
    ]);
  });
});

describe('messages never carry a value from the file', () => {
  const marker = 'MARKER-8f3c1d-do-not-echo';

  it('keeps an environment value out of every refusal', () => {
    const text = [
      'services:',
      '  web:',
      '    image: x',
      '    privileged: true',
      '    security_opt: [seccomp=unconfined]',
      '    environment:',
      `      TOKEN: ${marker}`,
      `      OTHER: "\${${marker}}"`,
      '    volumes:',
      '      - /etc:/e',
      `    env_file: ../${marker}.env`,
      '',
    ].join('\n');
    const refusals = refusalsOf(validateCompose(input(text)));
    expect(refusals.length).toBeGreaterThan(2);
    expect(JSON.stringify(refusals)).not.toContain(marker);
  });

  it('keeps a value out of the refusal of a bad shape', () => {
    const refusals = refusalsOf(
      validateCompose(input(`services:\n  web:\n    image: x\n    environment: ${marker}\n`)),
    );
    expect(JSON.stringify(refusals)).not.toContain(marker);
  });

  it('keeps the marker out of the stack of a refusal, which has none', () => {
    const result = validateCompose(
      input(
        `services:\n  web:\n    image: x\n    privileged: true\n    environment:\n      A: ${marker}\n`,
      ),
    );
    expect(result).not.toHaveProperty('stack');
  });
});

describe('fails closed', () => {
  const guarded = (extra: string) =>
    validateCompose(input(`services:\n  web:\n    image: x\n${extra}`));

  it.each([
    ['a key with different case', '    Privileged: true\n'],
    ['a key with trailing space', '    "privileged ": true\n'],
    ['a quoted key', '    "security_opt": [x]\n'],
    ['a key written as a flow mapping entry', '    {userns_mode: host}\n'],
  ])('refuses %s', (_name, extra) => {
    expect(guarded(extra).status).toBe('refused');
  });

  it('refuses a top-level key hidden behind an x- field', () => {
    const result = validateCompose(
      input('x-a: &a {privileged: true}\nservices:\n  web:\n    image: x\n    deploy: *a\n'),
    );
    expect(result.status).toBe('refused');
  });

  it('judges a stack handed in with Windows line endings the same', () => {
    const result = validateCompose(
      input('services:\r\n  web:\r\n    image: x\r\n    privileged: true\r\n'),
    );
    expect(refusalsOf(result).map((r) => r.code)).toContain('privileged');
  });

  it('refuses a byte order mark followed by a hidden key the same as without it', () => {
    const result = validateCompose(
      input('﻿services:\n  web:\n    image: x\n    privileged: true\n'),
    );
    expect(result.status).toBe('refused');
  });

  it('refuses a non-integer or out-of-range entry port', () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        refusalsOf(validateCompose(input('services:\n  web:\n    image: x\n', 'web', port))).map(
          (r) => r.code,
        ),
      ).toEqual(['entry_port_invalid']);
    }
    for (const port of [1, 80, 65535]) {
      expect(validateCompose(input('services:\n  web:\n    image: x\n', 'web', port)).status).toBe(
        'accepted',
      );
    }
  });

  it('refuses instead of throwing on input of the wrong type', () => {
    const odd = [
      { text: null, entryService: 'web', entryPort: 80 },
      { text: 'services: {}', entryService: undefined, entryPort: 80 },
      { text: 'services:\n  web:\n    image: x\n', entryService: 'web', entryPort: '80' },
    ] as unknown as Parameters<typeof validateCompose>[0][];
    for (const value of odd) expect(validateCompose(value).status).toBe('refused');
  });
});
