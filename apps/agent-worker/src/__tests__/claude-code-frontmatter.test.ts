import { describe, expect, it } from 'vitest';
import { formatValue, readFrontmatter } from '../claude-code/frontmatter.js';

// The strict frontmatter reader of repository skills and agents.

const read = (front: string, body = 'Body\n') => readFrontmatter(`---\n${front}\n---\n${body}`);
const entries = (front: string) => {
  const result = read(front);
  if ('error' in result) throw new Error(result.error);
  return Object.fromEntries(result.entries);
};

describe('the frontmatter reader', () => {
  it('reads scalars, quoted strings, flow lists and block lists', () => {
    expect(
      entries(
        [
          'a: plain text',
          'b: "quoted: yes"',
          "c: 'it''s'",
          'd: true',
          'e: 5',
          'f: [x, "y z", \'w\']',
          'g:\n  - one\n  - two',
          'h:\n- three',
          'i: Read, Grep # trailing comment',
        ].join('\n'),
      ),
    ).toEqual({
      a: 'plain text',
      b: 'quoted: yes',
      c: "it's",
      d: true,
      e: 5,
      f: ['x', 'y z', 'w'],
      g: ['one', 'two'],
      h: ['three'],
      i: 'Read, Grep',
    });
  });

  it('reads folded and literal block scalars', () => {
    expect(entries('a: >-\n  one\n  two\nb: |\n  x\n  y\nc: 1')).toEqual({
      a: 'one two',
      b: 'x\ny\n',
      c: 1,
    });
  });

  it('lists nested mappings as keys without a readable value', () => {
    expect(entries('hooks:\n  PreToolUse:\n    - matcher: "*"\nmcpServers: {}\nname: x')).toEqual({
      hooks: undefined,
      mcpServers: undefined,
      name: 'x',
    });
  });

  it('returns the body after the closing line', () => {
    const result = read('a: 1', 'Line one\n---\nLine two\n');

    expect(result).toEqual({ entries: [['a', 1]], body: 'Line one\n---\nLine two\n' });
  });

  it('treats a file without frontmatter as all body', () => {
    expect(readFrontmatter('Just text\n')).toEqual({ entries: [], body: 'Just text\n' });
  });

  it.each([
    ['unterminated', '---\na: 1\n', 'unterminated frontmatter'],
    ['a list', '---\n- a\n---\n', 'frontmatter is not a mapping'],
    ['garbage', '---\nnot a mapping line\n---\n', 'invalid frontmatter'],
    ['a duplicate key', '---\na: 1\na: 2\n---\n', 'invalid frontmatter'],
  ])('rejects %s', (_name, text, error) => {
    expect(readFrontmatter(text)).toEqual({ error });
  });

  it('gives no value for unclosed quotes, lists or mixed block lists', () => {
    expect(entries('a: "open\nb: [x\nc:\n  - ok\n  - key: nested\nd: {x: 1}')).toEqual({
      a: undefined,
      b: undefined,
      c: undefined,
      d: undefined,
    });
  });
});

describe('formatting a value', () => {
  it('is plain when safe and JSON otherwise', () => {
    expect(formatValue('Read, Grep')).toBe('Read, Grep');
    expect(formatValue('Reviews: code')).toBe('"Reviews: code"');
    expect(formatValue('true')).toBe('"true"');
    expect(formatValue('multi\nline')).toBe('"multi\\nline"');
    expect(formatValue(5)).toBe('5');
    expect(formatValue(false)).toBe('false');
    expect(formatValue(['a', 'b'])).toBe('["a","b"]');
  });
});
