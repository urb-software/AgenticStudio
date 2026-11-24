import type { PreviewMergeRebuild } from '../domain/entities/preview-merge-rebuild.js';
import type {
  MergeRebuildRuleDecision,
  MergeRebuildWaitReason,
} from '../domain/value-objects/merge-rebuild-rule.js';
import type { PreviewRepositoryReason } from '../domain/errors/preview-settings-errors.js';
import type { PreviewSettings } from '../domain/entities/preview-settings.js';
import { PreviewHostname } from '../domain/value-objects/preview-hostname.js';
import type { PreviewOperation } from '../domain/entities/preview-operation.js';
import type { PreviewFailureCode } from '../domain/value-objects/preview-failure-code.js';
import type { PreviewOperationStatus } from '../domain/value-objects/preview-operation-status.js';
import type { PreviewStateName } from '../domain/value-objects/preview-state.js';

export type PreviewBuildStatusView = 'queued' | 'building' | 'succeeded' | 'failed';

/** What started a build: the operator, or the merge of a Run through Studio. */
export type PreviewBuildStartedByView = { kind: 'operator' } | { kind: 'merge'; runId: string };

/** What the operator sees of one build. */
export interface PreviewBuildView {
  id: string;
  commit: string;
  startedBy: PreviewBuildStartedByView;
  status: PreviewBuildStatusView;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  timeLimitMinutes: number;
  failure: {
    code: PreviewFailureCode;
    detail: string;
    refusals: { code: string; place: string; message: string }[];
    previewRemoved: boolean;
  } | null;
  log: { bytes: number; truncated: boolean };
}

export type PreviewChangeKindView = 'stop' | 'reset_data';
export type PreviewChangeStatusView = 'queued' | 'in_progress' | 'succeeded' | 'failed';

/** What the operator sees of the newest stop or data removal. */
export interface PreviewChangeView {
  kind: PreviewChangeKindView;
  status: PreviewChangeStatusView;
  requestedAt: Date;
  finishedAt: Date | null;
  failure: { code: PreviewFailureCode; detail: string } | null;
}

export type PreviewMergeRebuildStatusView = 'waiting' | 'failed';

/** What the operator sees of the rebuild a merge asked for that has not started. */
export interface PreviewMergeRebuildView {
  runId: string;
  status: PreviewMergeRebuildStatusView;
  /** Finishes "waiting for ..." while waiting; why it failed otherwise. */
  reason: string;
  since: Date;
}

/** What the operator sees of a Preview's state. */
export interface PreviewStateView {
  state: PreviewStateName;
  running: { buildId: string; commit: string; since: Date; url: string | null } | null;
  latestBuild: PreviewBuildView | null;
  latestChange: PreviewChangeView | null;
  controller: { connected: boolean };
  /** A build is requested or claimed. */
  buildActive: boolean;
  /** The Clone is ready and holds another commit than the one that runs, or ran last. */
  behind: boolean;
  mergeRebuild: PreviewMergeRebuildView | null;
}

const BUILD_STATUS: Record<PreviewOperationStatus, PreviewBuildStatusView> = {
  requested: 'queued',
  claimed: 'building',
  succeeded: 'succeeded',
  failed: 'failed',
};

const CHANGE_STATUS: Record<PreviewOperationStatus, PreviewChangeStatusView> = {
  requested: 'queued',
  claimed: 'in_progress',
  succeeded: 'succeeded',
  failed: 'failed',
};

/** The view of a stop or data removal. Throws when the operation is neither. */
export function previewChangeView(operation: PreviewOperation): PreviewChangeView {
  if (operation.kind !== 'stop' && operation.kind !== 'remove_data') {
    throw new Error('Only a stop or a data removal has a change view.');
  }
  const failure = operation.failure;
  return {
    kind: operation.kind === 'stop' ? 'stop' : 'reset_data',
    status: CHANGE_STATUS[operation.status],
    requestedAt: operation.requestedAt,
    finishedAt: operation.finishedAt,
    failure: failure === null ? null : { code: failure.code, detail: failure.detail },
  };
}

/** The view of a build operation. Throws when the operation is not a build. */
export function previewBuildView(operation: PreviewOperation): PreviewBuildView {
  const { build } = operation;
  if (build === null) throw new Error('Only a build has a build view.');
  const failure = operation.failure;
  return {
    id: operation.id,
    commit: build.commit,
    startedBy:
      build.startedByRunId === null
        ? { kind: 'operator' }
        : { kind: 'merge', runId: build.startedByRunId },
    status: BUILD_STATUS[operation.status],
    requestedAt: operation.requestedAt,
    startedAt: operation.claimedAt,
    finishedAt: operation.finishedAt,
    timeLimitMinutes: build.limits.buildMinutes,
    failure:
      failure === null
        ? null
        : {
            code: failure.code,
            detail: failure.detail,
            refusals: failure.refusals.map(({ code, place, message }) => ({
              code,
              place,
              message,
            })),
            previewRemoved: operation.previewRemoved,
          },
    log: { bytes: operation.log.bytes, truncated: operation.log.truncated },
  };
}

/** What the operator sees of a Project's Preview: the settings, the hostname, the state and the latest build. */
export interface PreviewView {
  settings: { composeFile: string; service: string; port: number; updatedAt: Date } | null;
  /** `null` while no preview domain is configured. */
  hostname: string | null;
  hostnameUnavailable?: 'not_configured';
  repository: {
    ready: boolean;
    reason?: PreviewRepositoryReason;
    /** The commit the Clone holds, when the Repository is ready. */
    commit?: string;
  };
  state: PreviewStateView['state'];
  running: PreviewStateView['running'];
  latestBuild: PreviewStateView['latestBuild'];
  latestChange: PreviewStateView['latestChange'];
  controller: PreviewStateView['controller'];
  behind: PreviewStateView['behind'];
  mergeRebuild: PreviewStateView['mergeRebuild'];
}

export function previewView(input: {
  projectId: string;
  settings: PreviewSettings | null;
  domain: string | null;
  /** `null` when the Repository is ready. */
  repositoryReason: PreviewRepositoryReason | null;
  /** The commit of a ready Repository. */
  commit: string | null;
  stateView: PreviewStateView;
}): PreviewView {
  const { settings, domain, repositoryReason, commit, stateView } = input;
  return {
    settings: settings
      ? {
          composeFile: settings.composeFile,
          service: settings.service,
          port: settings.port,
          updatedAt: new Date(settings.updatedAt),
        }
      : null,
    ...(domain === null
      ? { hostname: null, hostnameUnavailable: 'not_configured' as const }
      : { hostname: PreviewHostname.of(input.projectId, domain).value }),
    repository:
      repositoryReason === null
        ? { ready: true, ...(commit === null ? {} : { commit }) }
        : { ready: false, reason: repositoryReason },
    state: stateView.state,
    running: stateView.running,
    latestBuild: stateView.latestBuild,
    latestChange: stateView.latestChange,
    controller: stateView.controller,
    behind: stateView.behind,
    mergeRebuild: stateView.mergeRebuild,
  };
}

const WAITING_FOR: Record<MergeRebuildWaitReason, string> = {
  clone_not_ready: 'the Repository',
  clone_fetch: 'the Clone fetch',
  build_active: 'the current build',
  change_active: 'the current stop or data removal',
  controller: 'an environment controller',
  free_place: 'a free place of the running Previews limit',
  error: 'a problem on the Studio side',
};

/** The rebuild as the operator sees it; `decision` is the rule's answer for it now. */
export function previewMergeRebuildView(
  rebuild: PreviewMergeRebuild,
  decision: MergeRebuildRuleDecision,
): PreviewMergeRebuildView {
  if (rebuild.isFailed) {
    return {
      runId: rebuild.runId,
      status: 'failed',
      reason: rebuild.failure ?? '',
      since: rebuild.failedAt ?? rebuild.recordedAt,
    };
  }
  return {
    runId: rebuild.runId,
    status: 'waiting',
    reason: decision.action === 'wait' ? WAITING_FOR[decision.reason] : 'the next check',
    since: rebuild.recordedAt,
  };
}
