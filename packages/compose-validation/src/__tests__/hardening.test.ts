import { describe, expect, it } from 'vitest';
import { MAX_TEXT_BYTES, validateCompose, type ComposeResult } from '../index.js';

const input = (text: string, entryService = 'web') => ({ text, entryService, entryPort: 8080 });

function accepted(result: ComposeResult) {
  if (result.status !== 'accepted') throw new Error(JSON.stringify(result));
  return result;
}

/** Pads a document with a comment up to the size limit. */
function atTheLimit(text: string): string {
  return text + '#' + 'a'.repeat(Math.max(0, MAX_TEXT_BYTES - text.length - 1));
}

describe('time budget on the largest inputs', () => {
  const BUDGET_MS = 2000;
  const keys = (count: number, separator: string) =>
    Array.from({ length: count }, (_, index) => `k${index}: 1`).join(separator);

  const worstCases: [string, string][] = [
    [
      'a flow mapping with the most keys',
      `services:\n  web: {image: n, labels: {${keys(31_000, ', ')}}}\n`,
    ],
    [
      'a block environment with the most keys',
      `services:\n  web:\n    image: n\n    environment:\n${keys(20_000, '\n').replace(/^/gm, '      ')}\n`,
    ],
    [
      'the most unknown service keys (every one a refusal)',
      `services:\n  web:\n    image: n\n${keys(20_000, '\n').replace(/^/gm, '    ')}\n`,
    ],
    [
      'ten thousand distinct anchors, each used once',
      `x-a: [${Array.from({ length: 9_990 }, (_, i) => `&a${i} 1`).join(',')}]\nx-b: [${Array.from({ length: 9_990 }, (_, i) => `*a${i}`).join(',')}]\nservices:\n  web: {image: n}\n`,
    ],
    [
      'fourteen thousand distinct anchors on mappings',
      `x-a: [${Array.from({ length: 14_000 }, (_, i) => `&a${i} {}`).join(',')}]\nx-b: [${Array.from({ length: 14_000 }, (_, i) => `*a${i}`).join(',')}]\nservices:\n  web: {image: n}\n`,
    ],
    [
      'sixty thousand empty mappings (the node cap counts mappings too)',
      `x-a: [${'{},'.repeat(60_000)}{}]\nservices:\n  web: {image: n}\n`,
    ],
    [
      'a long flow sequence',
      `services:\n  web:\n    image: n\n    command: [${'1,'.repeat(100_000)}1]\n`,
    ],
    [
      'the most services',
      'services:\n' + Array.from({ length: 12_000 }, (_, i) => `  s${i}: {}\n`).join(''),
    ],
  ];

  for (const [name, text] of worstCases) {
    it(`finishes ${name} within the budget`, () => {
      const padded =
        text.length <= MAX_TEXT_BYTES ? atTheLimit(text) : text.slice(0, MAX_TEXT_BYTES);
      const started = performance.now();
      const result = validateCompose(input(padded));
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
      expect(result.status).toBe('refused');
      if (result.status === 'refused') expect(result.refusals.length).toBeLessThanOrEqual(100);
    });
  }
});

describe('duplicate keys', () => {
  it('refuses a duplicate key in any mapping', () => {
    const result = validateCompose(input('services:\n  web:\n    image: a\n    image: b\n'));
    expect(result.status === 'refused' && result.refusals.map((r) => r.code)).toEqual([
      'duplicate_key',
    ]);
  });

  it('allows an explicit key to override a merged one', () => {
    const text =
      'x-a: &a {restart: always}\nservices:\n  web:\n    <<: *a\n    restart: no\n    image: a\n';
    expect(accepted(validateCompose(input(text))).stack).toEqual({
      services: { web: { restart: 'no', image: 'a' } },
    });
  });
});

describe('removed ports', () => {
  it('reports every service whose ports were removed, also those sharing an anchor', () => {
    const text =
      'services:\n  web: &s\n    image: n\n    ports: ["80:80"]\n  web2: *s\n  web3:\n    <<: *s\n    image: m\n';
    const result = accepted(validateCompose(input(text)));
    expect(result.removedPorts).toEqual([
      { service: 'web', place: 'services.web.ports[0]' },
      { service: 'web2', place: 'services.web2.ports[0]' },
      { service: 'web3', place: 'services.web3.ports[0]' },
    ]);
    expect(JSON.stringify(result.stack)).not.toContain('ports');
  });

  it('writes the place of a service with a dot in its name unambiguously', () => {
    const result = accepted(
      validateCompose(input('services:\n  web: {image: n}\n  a.b: {image: n, ports: ["1:1"]}\n')),
    );
    expect(result.removedPorts).toEqual([{ service: 'a.b', place: 'services["a.b"].ports[0]' }]);
  });
});

describe('the normalised stack', () => {
  it('drops the project name, so the controller names the project', () => {
    const result = accepted(validateCompose(input('name: other\nservices:\n  web: {image: n}\n')));
    expect(result.stack).toEqual({ services: { web: { image: 'n' } } });
  });
});
