import { PROVIDER_MODELS } from '@agentic-studio/agent-definitions';
import { AgentFailedError, UsageLimitError } from '../runner.js';
import { describe, expect, it } from 'vitest';
import {
  ModelNotAllowedError,
  modelOption,
  classifyModelFailure,
  ModelRefusedError,
  refusesModel,
} from '../model-option.js';

// The model option of a Provider's CLI: only a value of the Provider's fixed list reaches it.

describe('the model option', () => {
  it('adds no option for the default model or for no model', () => {
    expect(modelOption('claude_code', 'default')).toEqual([]);
    expect(modelOption('codex', 'default')).toEqual([]);
    expect(modelOption('claude_code', undefined)).toEqual([]);
  });

  it.each([
    ['claude_code', 'opus'],
    ['claude_code', 'sonnet'],
    ['claude_code', 'haiku'],
    ['codex', 'gpt-6.2-astra'],
    ['codex', 'gpt-6.2-sol'],
    ['codex', 'gpt-6.1-sol'],
    ['codex', 'gpt-6-luna'],
  ] as const)('passes %s model %s as --model', (provider, model) => {
    expect(modelOption(provider, model)).toEqual(['--model', model]);
  });

  it('knows exactly the approved values of the compliance records', () => {
    expect(PROVIDER_MODELS.claude_code).toEqual(['default', 'opus', 'sonnet', 'haiku']);
    expect(PROVIDER_MODELS.codex).toEqual([
      'default',
      'gpt-6.2-astra',
      'gpt-6.2-sol',
      'gpt-6.1-sol',
      'gpt-6-luna',
    ]);
  });

  it.each([
    ['claude_code', 'gpt-6-luna'],
    ['codex', 'opus'],
    ['claude_code', 'claude-opus-4-1'],
    ['claude_code', 'OPUS'],
    ['claude_code', ''],
    ['codex', '--sandbox=danger-full-access'],
    ['claude_code', 'opus --dangerously-skip-permissions'],
    ['claude_code', ' opus'],
    ['claude_code', 'Opus'],
    ['claude_code', 'opus '],
    ['claude_code', 'opus\n'],
  ] as const)('refuses %s model %j', (provider, model) => {
    expect(() => modelOption(provider, model)).toThrow(ModelNotAllowedError);
  });

  it('names the value and the allowed ones in the refusal', () => {
    expect(() => modelOption('claude_code', 'gpt-6-luna')).toThrow(
      /gpt-6-luna.*Claude Code.*opus, sonnet, haiku/s,
    );
  });
});

describe('what counts as a refused model', () => {
  it.each([
    "There's an issue with the selected model (opus). It may not exist or you may not have access to it.",
    "Codex ended with an error: The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.",
    'The model `gpt-6.2-sol` does not exist or you do not have access to it.',
    'Error: unknown model: gpt-6.1-sol',
    'model_not_found',
    'Invalid model name',
  ])('recognises %j', (text) => {
    expect(refusesModel(text)).toBe(true);
  });

  it.each([
    'The model is overloaded and not available right now. Try again later.',
    'Error: invalid settings file',
    'Error: --json-schema is not a valid JSON Schema',
    'Claude Code exited with code 2 without a result.',
    "The Claude Code usage limit was reached. I'll model the data as asked.",
    '',
  ])('does not recognise %j', (text) => {
    expect(refusesModel(text)).toBe(false);
  });

  it('is an error of its own with the CLI reason in its message', () => {
    const error = new ModelRefusedError('opus', 'Its error output: no access');
    expect(error.message).toBe(
      'The provider refused the model "opus". Its error output: no access',
    );
    expect(error).toBeInstanceOf(Error);
  });
});

describe('classifying a failed step', () => {
  const refusal = "There's an issue with the selected model (opus). It may not exist.";
  const exited = new AgentFailedError('Claude Code exited with code 1 without a result.');

  it('reclassifies only a plain agent failure whose own reason says the model is refused', () => {
    const error = classifyModelFailure(exited, 'opus', { lastErrorLine: refusal });

    expect(error).toBeInstanceOf(ModelRefusedError);
    expect(error.message).toBe(
      `The provider refused the model "opus". ${exited.message} The CLI said: ${refusal}`,
    );
  });

  it('quotes the matching line, not a later one, and uses the error result text', () => {
    const ended = new AgentFailedError('Claude Code ended with an error (success).');

    const error = classifyModelFailure(ended, 'opus', {
      streamReason: `Warning: x
${refusal}
Error: exiting`,
    });

    expect(error.message).toContain(`The CLI said: ${refusal}`);
    expect(error.message).not.toContain('exiting');
  });

  it('never reclassifies a usage limit, an invalid result or a default-model step', () => {
    const limit = new UsageLimitError('limit', 'sess-1');
    expect(classifyModelFailure(limit, 'opus', { lastErrorLine: refusal })).toBe(limit);
    const invalid = new AgentFailedError('Claude Code ended without a valid structured result.');
    expect(classifyModelFailure(invalid, 'opus', { lastErrorLine: refusal })).toBe(invalid);
    expect(classifyModelFailure(exited, 'default', { lastErrorLine: refusal })).toBe(exited);
  });

  it('leaves an overloaded message an agent failure', () => {
    const overloaded = 'The model is overloaded and not available right now.';
    expect(classifyModelFailure(exited, 'opus', { lastErrorLine: overloaded })).toBe(exited);
  });
});
