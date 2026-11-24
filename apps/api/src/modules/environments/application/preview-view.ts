import type { PreviewRepositoryReason } from '../domain/errors/preview-settings-errors.js';
import type { PreviewSettings } from '../domain/entities/preview-settings.js';
import { PreviewHostname } from '../domain/value-objects/preview-hostname.js';
import type { PreviewOperation } from '../domain/entities/preview-operation.js';
import type { PreviewFailureCode } from '../domain/value-objects/preview-failure-code.js';
import type { PreviewOperationStatus } from '../domain/value-objects/preview-operation-status.js';
import type { PreviewStateName } from '../domain/value-objects/preview-state.js';

export type PreviewBuildStatusView = 'queued' | 'building' | 'succeeded' | 'failed';

/** What the operator sees of one build. */
export interface PreviewBuildView {
  id: string;
  commit: string;
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

/** What the operator sees of a Preview's state. */
export interface PreviewStateView {
  state: PreviewStateName;
  running: { buildId: string; commit: string; since: Date; url: string | null } | null;
  latestBuild: PreviewBuildView | null;
  controller: { connected: boolean };
  /** A build is requested or claimed. */
  buildActive: boolean;
}

const BUILD_STATUS: Record<PreviewOperationStatus, PreviewBuildStatusView> = {
  requested: 'queued',
  claimed: 'building',
  succeeded: 'succeeded',
  failed: 'failed',
};

/** The view of a build operation. Throws when the operation is not a build. */
export function previewBuildView(operation: PreviewOperation): PreviewBuildView {
  const { build } = operation;
  if (build === null) throw new Error('Only a build has a build view.');
  const failure = operation.failure;
  return {
    id: operation.id,
    commit: build.commit,
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
  controller: PreviewStateView['controller'];
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
    controller: stateView.controller,
  };
}
