import { errorReason } from './cli-output.js';
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
 * How a CLI's own error text says the model is refused: it names the model and says it is unknown,
 * unsupported or not available to the login. Deliberately narrow; anything else stays an agent
 * failure.
 */
const MODEL_REFUSAL_TEXT = new RegExp(
  [
    String.raw`issue with the selected model`,
    String.raw`model_not_found`,
    String.raw`\b(?:unknown|invalid|unsupported|unrecognized) model\b`,
    String.raw`\bmodel\b[^\n]{0,80}\b(?:not found|does not exist|do not have access|not supported|not available|not allowed|may not exist)\b`,
  ].join('|'),
  'i',
);

/** Whether the CLI's error text says it refuses the model. */
export function refusesModel(text: string): boolean {
  return MODEL_REFUSAL_TEXT.test(text);
}

/**
 * The error a failed step ends with: {@link ModelRefusedError} when the step ran with a model of
 * the list (not `default`) and the error or the CLI's output says it refuses it, else `error`
 * itself. The CLI's own line goes into the detail when the error does not carry it yet.
 */
export function classifyModelFailure(
  error: Error,
  model: string,
  cliOutput: readonly string[],
): Error {
  if (model === MODEL_DEFAULT) return error;
  const hit = cliOutput.find(refusesModel);
  if (hit === undefined && !refusesModel(error.message)) return error;
  const reason =
    hit === undefined || error.message.includes('Its error output:')
      ? error.message
      : `${error.message} ${errorReason(hit)}`;
  return new ModelRefusedError(model, reason);
}
