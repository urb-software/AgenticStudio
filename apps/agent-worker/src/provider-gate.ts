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
 * A Run asked for a provider whose switch is off, or (Issue #105) whose switch is on but which
 * this worker found unavailable at start (`reason`, e.g. an unsupported CLI version). Its
 * message is safe to show: it names the provider and the switch or the reason, never a value,
 * a path or a credential.
 */
export class ProviderDisabledError extends Error {
  constructor(
    readonly provider: Provider,
    readonly reason?: string,
  ) {
    super(
      reason === undefined
        ? `${PROVIDER_NAMES[provider]} is switched off on the agent worker. ` +
            `The operator enables it with ${PROVIDER_SWITCH_VARIABLES[provider]} in the worker's ` +
            'configuration, after its compliance record is approved, and restarts the worker.'
        : `${PROVIDER_NAMES[provider]} is unavailable on the agent worker: ${reason}`,
    );
    this.name = 'ProviderDisabledError';
  }
}

/** Why a switched-on provider cannot run on this worker (Issue #105), per provider. */
export type ProviderReasons = Readonly<Partial<Record<Provider, string>>>;

/**
 * The provider gate (Issue #101): holds a frozen copy of the switches read at start. It is
 * checked by the runner dispatcher before every Run step and again by the spawn boundary
 * before any provider CLI process is created. Nothing a Run carries reaches it.
 */
export class ProviderGate {
  private readonly switches: ProviderSwitches;
  private readonly unavailable: ProviderReasons;

  /**
   * @param unavailable Issue #105: switched-on providers this worker cannot run, with the
   *   reason (found at start, e.g. by the CLI version check). They stay off for the life of the
   *   process; the switches themselves keep their meaning.
   */
  constructor(switches: ProviderSwitches, unavailable: ProviderReasons = {}) {
    const copy = {} as Record<Provider, boolean>;
    const reasons: Partial<Record<Provider, string>> = {};
    for (const provider of PROVIDERS) {
      copy[provider] = switches[provider] === true;
      const reason = Object.hasOwn(unavailable, provider) ? unavailable[provider] : undefined;
      if (copy[provider] && reason !== undefined) reasons[provider] = reason;
    }
    this.switches = Object.freeze(copy);
    this.unavailable = Object.freeze(reasons);
  }

  isEnabled(provider: Provider): boolean {
    // Only a known provider whose own switch is exactly on and that is not unavailable.
    return (
      Object.hasOwn(this.switches, provider) &&
      this.switches[provider] === true &&
      !Object.hasOwn(this.unavailable, provider)
    );
  }

  /** Throws {@link ProviderDisabledError} unless the provider's switch is on and it is available. */
  assertEnabled(provider: Provider): void {
    if (this.isEnabled(provider)) return;
    const reason = Object.hasOwn(this.unavailable, provider)
      ? this.unavailable[provider]
      : undefined;
    throw new ProviderDisabledError(provider, reason);
  }

  /** What the worker reports to Studio (`POST /api/worker/status`): the switches as read. */
  snapshot(): ProviderSwitches {
    return this.switches;
  }

  /** Why switched-on providers are unavailable (`providerReasons` in the status report). */
  reasons(): ProviderReasons {
    return this.unavailable;
  }
}
