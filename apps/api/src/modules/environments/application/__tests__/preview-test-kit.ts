import type { PreviewOperationRepository } from '../../domain/repositories/preview-operation-repository.js';
import { FakeControllerPresence } from '../ports/__tests__/fake-controller-presence.js';
import type { FakePreviewSources } from '../ports/__tests__/fake-preview-sources.js';
import type { PreviewOperationSettings } from '../ports/preview-operation-settings.js';
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
