import { describe, expect, it } from 'vitest';
import { Task, TASK_MAX_LENGTH } from '../task.js';
import { InvalidTaskError } from '../../errors/run-errors.js';

describe('Task', () => {
  it('trims the text it is made of', () => {
    expect(Task.of('  Add a health check \n').value).toBe('Add a health check');
    expect(String(Task.of(' x '))).toBe('x');
  });

  it.each(['', '   ', '\n\t '])('refuses %j: nothing is left after trimming', (text) => {
    expect(() => Task.of(text)).toThrow(InvalidTaskError);
    expect(() => Task.of(text)).toThrow('Enter a task.');
  });

  it('accepts exactly the longest Task and refuses one character more', () => {
    expect(Task.of('x'.repeat(TASK_MAX_LENGTH)).value).toHaveLength(TASK_MAX_LENGTH);

    const error = (() => {
      try {
        Task.of('x'.repeat(TASK_MAX_LENGTH + 1));
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(InvalidTaskError);
    expect((error as InvalidTaskError).reason).toBe('too_long');
  });

  it('counts the length after trimming, not before', () => {
    expect(Task.of(` ${'x'.repeat(TASK_MAX_LENGTH)} `).value).toHaveLength(TASK_MAX_LENGTH);
  });
});
