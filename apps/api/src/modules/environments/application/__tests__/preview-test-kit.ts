import { PreviewOperation } from '../../domain/entities/preview-operation.js';
import { PreviewSettings } from '../../domain/entities/preview-settings.js';
import type { PreviewOperationRepository } from '../../domain/repositories/preview-operation-repository.js';
import type { PreviewSettingsRepository } from '../../domain/repositories/preview-settings-repository.js';
import { PreviewCommit } from '../../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../../domain/value-objects/preview-limits.js';
import { PreviewOperationFailure } from '../../domain/value-objects/preview-operation-failure.js';
import { PreviewPort } from '../../domain/value-objects/preview-port.js';
import { PreviewService } from '../../domain/value-objects/preview-service.js';
import { FakeControllerPresence } from '../ports/__tests__/fake-controller-presence.js';
import type { FakePreviewSources } from '../ports/__tests__/fake-preview-sources.js';
import type { PreviewOperationSettings } from '../ports/preview-operation-settings.js';
import type { PreviewLimitsSettings } from '../ports/preview-limits-settings.js';
import { PreviewBuildRequests } from '../preview-build-requests.js';
import { PreviewComposeJudge } from '../preview-compose-judge.js';
import { PreviewStateReader } from '../preview-state-reader.js';

export const KIT_NOW = new Date('2026-11-24T10:00:00.000Z');

export const OPERATION_SETTINGS: PreviewOperationSettings = {
  leaseSeconds: 60,
  logMaxBytes: 1024 * 1024,
  snapshotGraceMs: 3_600_000,
  unclaimedMinutes: 5,
};

/** The collaborators of the Preview handlers, built over the in-memory fakes. */
export function previewKit(
  operations: PreviewOperationRepository,
  sources: FakePreviewSources,
  now: Date = KIT_NOW,
  /** How long the API instance has run. */
  startedAgoMs = 3_600_000,
) {
  const presence = new FakeControllerPresence(new Date(now.getTime() - startedAgoMs));
  const clock = { now: () => now };
  return {
    presence,
    clock,
    judge: new PreviewComposeJudge(sources),
    states: new PreviewStateReader(operations, presence, OPERATION_SETTINGS, clock),
  };
}

export const BUILD_LIMITS: PreviewLimitsSettings = {
  memoryMiB: 2048,
  cpuPercent: 200,
  tasksMax: 1024,
  buildMinutes: 30,
};

/** The shared build-request steps over the in-memory fakes, with the controller connected. */
export function previewBuildRequests(
  operations: PreviewOperationRepository,
  sources: FakePreviewSources,
  settings: PreviewSettingsRepository,
  options: { now?: Date; maxRunning?: number; limits?: PreviewLimitsSettings } = {},
) {
  const now = options.now ?? KIT_NOW;
  const kit = previewKit(operations, sources, now);
  kit.presence.seen = now;
  const requests = new PreviewBuildRequests(
    sources,
    settings,
    operations,
    options.limits ?? BUILD_LIMITS,
    { maxRunning: options.maxRunning ?? 3 },
    kit.clock,
    kit.judge,
    kit.presence,
    OPERATION_SETTINGS,
  );
  return { ...kit, requests };
}

/** Saves the settings the build requests are made from. */
export async function savePreviewSettings(
  settings: PreviewSettingsRepository,
  projectId: string,
  now: Date = KIT_NOW,
): Promise<void> {
  await settings.save(
    PreviewSettings.create({
      projectId,
      composeFile: PreviewComposeFile.of('deploy/compose.yaml'),
      service: PreviewService.of('web'),
      port: PreviewPort.of(8080),
      now,
    }),
  );
}

export const KIT_CONTROLLER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';

/** Stores a build of the Project in the status asked for; the final ones were claimed a minute before. */
export async function seedBuild(
  operations: PreviewOperationRepository,
  projectId: string,
  id: string,
  status: 'requested' | 'claimed' | 'succeeded' | 'failed',
  requestedAt: Date = KIT_NOW,
  commit = 'c'.repeat(40),
): Promise<void> {
  await operations.add(
    PreviewOperation.requestBuild({
      id,
      projectId,
      commit: PreviewCommit.of(commit),
      composeFile: PreviewComposeFile.of('deploy/compose.yaml'),
      service: PreviewService.of('web'),
      port: PreviewPort.of(8080),
      limits: PreviewLimits.of(BUILD_LIMITS),
      now: requestedAt,
    }),
  );
  if (status === 'requested') return;
  await operations.change(id, (op) => {
    op.claim(KIT_CONTROLLER, new Date(requestedAt.getTime() + 1000));
    if (status === 'succeeded') {
      op.succeed(KIT_CONTROLLER, null, new Date(requestedAt.getTime() + 60_000));
    }
    if (status === 'failed') {
      op.fail(
        KIT_CONTROLLER,
        PreviewOperationFailure.of('build_failed', 'x'),
        new Date(requestedAt.getTime() + 60_000),
      );
    }
  });
}
