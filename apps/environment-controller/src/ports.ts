import type {
  OperationRuntime,
  PreviewBuildLimits,
  PreviewLogStream,
} from '@agentic-studio/contracts';
import type { BuildLayout } from './layout.js';

/** Who a Preview is: only values the API produced and the controller validated. */
export interface PreviewIdentity {
  projectId: string;
  /** `preview-<32 hex>`: the Compose project and the slice. */
  composeProject: string;
  /** `preview-<12 hex>`: the socket name. */
  previewLabel: string;
}

/** Everything a Compose call needs: the layout, the entry service and the Compose environment. */
export interface PreviewRun extends PreviewIdentity {
  layout: BuildLayout;
  /** The Compose process environment: the fixed base and the Environment file values. */
  environment: Record<string, string>;
  /** The service and port the Preview routes to. */
  service: string;
  port: number;
}

export interface RuntimeCall {
  /** Aborts the processes (deadline, lost lease, shutdown). */
  signal: AbortSignal;
  /** Receives each output line of the processes. */
  onLine: (stream: PreviewLogStream, line: string) => void;
  killGraceMs?: number;
}

/** What the controller asks of Docker. A fake implements it for tests and the e2e stack. */
export interface ContainerRuntime {
  /** `compose build`. */
  build(run: PreviewRun, call: RuntimeCall): Promise<void>;
  /** `compose up --no-build`, then the socket bridge to the entry service. */
  start(run: PreviewRun, call: RuntimeCall): Promise<void>;
  /** Removes the bridge, the labelled containers (anonymous volumes with them) and networks. */
  removeContainers(identity: PreviewIdentity, call: RuntimeCall): Promise<void>;
  /** Removes the labelled volumes. */
  removeVolumes(identity: PreviewIdentity, call: RuntimeCall): Promise<void>;
  /** The labelled containers. */
  state(identity: PreviewIdentity, call: RuntimeCall): Promise<OperationRuntime>;
  /** Stops every bridge (the controller shuts down). */
  close(): Promise<void>;
}

/** One systemd slice per Preview. */
export interface PreviewSlices {
  apply(identity: PreviewIdentity, limits: PreviewBuildLimits, signal: AbortSignal): Promise<void>;
  remove(identity: PreviewIdentity, signal: AbortSignal): Promise<void>;
}

/** The egress rules of the Preview daemon's network namespace, read back. */
export interface EgressRules {
  /** Throws an `egress_rules_missing` failure unless the expected rules are in place. */
  verify(signal: AbortSignal): Promise<void>;
}
