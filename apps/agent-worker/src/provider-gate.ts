import {
  PROVIDER_NAMES,
  PROVIDERS,
  type Provider,
  type ProviderSwitches,
} from '@agentic-studio/contracts';

/**
 * The operator's per-provider switches (docs/engineering/security.md §2, Issue #101). They
 * live only in the worker's own deployment configuration: never in the database, never set
 * through the API, never taken from a Run.
 */
export const PROVIDER_SWITCH_VARIABLES = {
  claude_code: 'CLAUDE_CODE_ENABLED',
  codex: 'CODEX_CLI_ENABLED',
} as const satisfies Record<Provider, string>;

/**
 * Reads the switches once (the worker reads them at start; a change needs a restart).
 * Fail closed: only the exact value `true` enables a provider; missing, empty, `false`, `1`,
 * `yes`, `TRUE` and anything else mean disabled. Each provider has its own switch.
 */
export function readProviderSwitches(env: Record<string, string | undefined>): ProviderSwitches {
  const switches = {} as Record<Provider, boolean>;
  for (const provider of PROVIDERS) {
    switches[provider] = env[PROVIDER_SWITCH_VARIABLES[provider]] === 'true';
  }
  return Object.freeze(switches);
}

/**
 * A Run asked for a provider whose switch is off. Its message is safe to show: it names the
 * provider and the switch, never a value, a path or a credential.
 */
export class ProviderDisabledError extends Error {
  constructor(readonly provider: Provider) {
    super(
      `${PROVIDER_NAMES[provider]} is switched off on the agent worker. ` +
        `The operator enables it with ${PROVIDER_SWITCH_VARIABLES[provider]} in the worker's ` +
        'configuration, after its compliance record is approved, and restarts the worker.',
    );
    this.name = 'ProviderDisabledError';
  }
}

/**
 * The provider gate (Issue #101): holds a frozen copy of the switches read at start. It is
 * checked by the runner dispatcher before every Run step and again by the spawn boundary
 * before any provider CLI process is created. Nothing a Run carries reaches it.
 */
export class ProviderGate {
  private readonly switches: ProviderSwitches;

  constructor(switches: ProviderSwitches) {
    const copy = {} as Record<Provider, boolean>;
    for (const provider of PROVIDERS) copy[provider] = switches[provider] === true;
    this.switches = Object.freeze(copy);
  }

  isEnabled(provider: Provider): boolean {
    // Only a known provider whose own switch is exactly on; anything else is off.
    return Object.hasOwn(this.switches, provider) && this.switches[provider] === true;
  }

  /** Throws {@link ProviderDisabledError} unless the provider's switch is on. */
  assertEnabled(provider: Provider): void {
    if (!this.isEnabled(provider)) throw new ProviderDisabledError(provider);
  }

  /** What the worker reports to Studio (`POST /api/worker/status`). */
  snapshot(): ProviderSwitches {
    return this.switches;
  }
}
