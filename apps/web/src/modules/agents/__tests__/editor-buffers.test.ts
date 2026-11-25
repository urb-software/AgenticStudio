import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllBuffers,
  clearBuffer,
  readBuffers,
  writeBuffer,
} from '../features/agent-editor/editor-buffers';

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('editor buffers', () => {
  it('keeps unsaved text per path in sessionStorage, and reads it back', () => {
    writeBuffer('a.md', 'one');
    writeBuffer('b/c.md', 'two');
    expect(readBuffers()).toEqual({ 'a.md': 'one', 'b/c.md': 'two' });
  });

  it('clears one path or all of them', () => {
    writeBuffer('a.md', 'one');
    writeBuffer('b.md', 'two');
    clearBuffer('a.md');
    expect(readBuffers()).toEqual({ 'b.md': 'two' });
    clearAllBuffers();
    expect(readBuffers()).toEqual({});
  });

  it('leaves other session keys alone', () => {
    window.sessionStorage.setItem('other', 'x');
    writeBuffer('a.md', 'one');
    clearAllBuffers();
    expect(window.sessionStorage.getItem('other')).toBe('x');
  });

  it('works without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeBuffer('a.md', 'one')).not.toThrow();
    expect(readBuffers()).toEqual({});
  });
});
