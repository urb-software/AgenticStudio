import { describe, expect, it } from 'vitest';
import { InvalidPublishMessageError, PublishMessage } from '../publish-message.js';

describe('PublishMessage', () => {
  it('keeps a message as written, the first line being the subject', () => {
    const message = PublishMessage.of('Add the reviewer\n\nWhy: it reviews.\n');

    expect(message.value).toBe('Add the reviewer\n\nWhy: it reviews.\n');
    expect(message.subject).toBe('Add the reviewer');
  });

  it('takes one character and the longest allowed length', () => {
    expect(PublishMessage.of('x').value).toBe('x');
    expect(PublishMessage.of('x'.repeat(PublishMessage.MAX_LENGTH)).value).toHaveLength(2000);
  });

  it.each([
    ['empty', ''],
    ['blank', '  \n \t\n'],
    ['too long', 'x'.repeat(2001)],
    ['holding a NUL', 'a\0b'],
    ['with a blank subject line', '\nbody only'],
  ])('refuses a message that is %s', (_name, text) => {
    expect(() => PublishMessage.of(text)).toThrow(InvalidPublishMessageError);
  });
});
