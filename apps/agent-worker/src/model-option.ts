import { AgentFailedError } from './runner.js';
import { MODEL_DEFAULT, PROVIDER_MODELS, type Provider } from '@agentic-studio/agent-definitions';

/**
 * The model option of a Provider's CLI: exactly `--model <value>`, only for a value of the
 * Provider's fixed list. The argument builders call this, so no other value reaches a command.
 */

const PROVIDER_LABEL: Record<Provider, string> = { claude_code: 'Claude Code', codex: 'Codex' };

/** The Run's recorded model is not one of its Provider's models; the Run fails before the CLI starts. */
export class ModelNotAllowedError extends Error {
  constructor(provider: Provider, model: string) {
    const allowed = PROVIDER_MODELS[provider].filter((value) => value !== MODEL_DEFAULT);
    super(
      `The model ${JSON.stringify(model)} is not one ${PROVIDER_LABEL[provider]} may use ` +
        `(allowed: ${MODEL_DEFAULT}, ${allowed.join(', ')}).`,
    );
    this.name = 'ModelNotAllowedError';
  }
}

/**
 * `['--model', model]` for a model of the list, nothing for `default` (or no model): such a step
 * starts with the same command as without the feature. Any other value throws.
 */
export function modelOption(provider: Provider, model: string | undefined): string[] {
  if (model === undefined || model === MODEL_DEFAULT) return [];
  if (!(PROVIDER_MODELS[provider] as readonly string[]).includes(model)) {
    throw new ModelNotAllowedError(provider, model);
  }
  return ['--model', model];
}

/**
 * The CLI ended the step because it refuses the model (unknown to it, or not available to the
 * login). `message` is safe to show; the worker reports it as `model_refused`, and Studio
 * redacts the detail like any other.
 */
export class ModelRefusedError extends Error {
  constructor(model: string, reason: string) {
    super(`The provider refused the model ${JSON.stringify(model)}. ${reason}`);
    this.name = 'ModelRefusedError';
  }
}

/**
 * How a CLI's own error text says the model is refused. Deliberately narrow: a refusal worded
 * otherwise stays an agent failure, and the Run still shows the CLI's line as its reason.
 */
const MODEL_REFUSAL_TEXT = new RegExp(
  [
    String.raw`issue with the selected model`,
    String.raw`model_not_found`,
    String.raw`\b(?:unknown|invalid|unsupported|unrecognized) model\b`,
    String.raw`\bmodel\b[^\n]{0,80}\b(?:not found|does not exist|do not have access|not supported|not allowed|may not exist)\b`,
  ].join('|'),
  'i',
);

/** Whether the CLI's error text says it refuses the model. */
export function refusesModel(text: string): boolean {
  return MODEL_REFUSAL_TEXT.test(text);
}

/** Failures that carry no reason of their own: the CLI's last error line then is the reason. */
const NO_REASON_OF_ITS_OWN = /exited with code|was stopped|without a result|without completing/;

/** What ended a step, as far as the CLI said it. */
export interface StepEndReason {
  /** The CLI's own error text: the error result (Claude Code); Codex puts it in the error. */
  streamReason?: string | undefined;
  /** The last line of its standard error. */
  lastErrorLine?: string | undefined;
  /** What the Run shows for the failure, when it is more than the error's own message. */
  detail?: string | undefined;
}

/**
 * {@link ModelRefusedError} only for a plain agent failure of a step that ran with a model of the
 * list, when the reason that ended it says the model is refused; the matching line is quoted.
 * Anything else (usage limit, invalid result, `default` model) is returned as it is.
 */
export function classifyModelFailure(error: Error, model: string, end: StepEndReason): Error {
  if (!(error instanceof AgentFailedError)) return error;
  const shown = end.detail ?? error.message;
  const unchanged = end.detail === undefined ? error : new AgentFailedError(shown);
  if (model === MODEL_DEFAULT) return unchanged;
  const texts = [end.streamReason, error.message];
  if (NO_REASON_OF_ITS_OWN.test(error.message)) texts.push(end.lastErrorLine);
  const hit = texts
    .flatMap((text) => (text ?? '').split('\n'))
    .map((text) => text.trim())
    .find(refusesModel);
  if (hit === undefined) return unchanged;
  const quoted = shown.includes(hit) ? '' : ` The CLI said: ${cut(hit)}`;
  return new ModelRefusedError(model, `${shown}${quoted}`);
}

const cut = (text: string): string => (text.length > 500 ? `${text.slice(0, 499)}…` : text);
