import { describe, expect, it } from 'vitest';
import {
  PREVIEW_BUILD_STATUSES,
  PREVIEW_STATES,
  previewBuildEventsSchema,
  previewLatestChangeSchema,
  previewLimitReachedProblemSchema,
  previewsListSchema,
  previewBuildSchema,
  previewRefusalCodeSchema,
  previewSchema,
  previewStateSchema,
  savePreviewSettingsRequestSchema,
  savePreviewSettingsResponseSchema,
} from '../index.js';

const REQUEST = { composeFile: 'compose.yaml', service: 'web', port: 3000 };

describe('preview contract', () => {
  it('accepts the three settings and nothing else', () => {
    expect(savePreviewSettingsRequestSchema.safeParse(REQUEST).success).toBe(true);
    expect(savePreviewSettingsRequestSchema.safeParse({ ...REQUEST, extra: 1 }).success).toBe(
      false,
    );
    expect(savePreviewSettingsRequestSchema.safeParse({ ...REQUEST, port: '3000' }).success).toBe(
      false,
    );
  });

  it('checks the shape of the service and the port', () => {
    for (const bad of [
      { service: '' },
      { service: '-web' },
      { service: 'a'.repeat(64) },
      { port: 0 },
      { port: 65536 },
      { port: 80.5 },
    ]) {
      expect(savePreviewSettingsRequestSchema.safeParse({ ...REQUEST, ...bad }).success).toBe(
        false,
      );
    }
    expect(
      savePreviewSettingsRequestSchema.safeParse({
        ...REQUEST,
        service: 'a'.repeat(63),
        port: 65535,
      }).success,
    ).toBe(true);
  });

  const STATE = {
    state: 'stopped',
    running: null,
    latestBuild: null,
    latestChange: null,
    controller: { connected: false },
  };

  it('answers the settings or null, with the hostname or why there is none', () => {
    const repository = { ready: true };
    expect(
      previewSchema.safeParse({ settings: null, hostname: null, repository, ...STATE }).success,
    ).toBe(true);
    expect(
      previewSchema.safeParse({
        settings: { ...REQUEST, updatedAt: '2026-11-23T10:00:00.000Z' },
        hostname: 'preview-0123456789ab.example.test',
        repository: { ready: true, commit: 'a'.repeat(40) },
        ...STATE,
      }).success,
    ).toBe(true);
    expect(
      savePreviewSettingsResponseSchema.safeParse({
        settings: null,
        hostname: null,
        hostnameUnavailable: 'not_configured',
        repository,
        ...STATE,
        removedPorts: [{ service: 'web', place: 'services.web.ports[0]' }],
      }).success,
    ).toBe(true);
  });

  it('requires the state, the running build, the latest build and the controller', () => {
    const base = { settings: null, hostname: null, repository: { ready: true } };
    for (const missing of ['state', 'running', 'latestBuild', 'controller']) {
      const rest = Object.fromEntries(Object.entries(STATE).filter(([key]) => key !== missing));
      expect(previewSchema.safeParse({ ...base, ...rest }).success).toBe(false);
    }
  });

  it('has the seven states and the four build statuses', () => {
    expect([...PREVIEW_STATES]).toEqual([
      'not_configured',
      'stopped',
      'stopping',
      'resetting_data',
      'building',
      'running',
      'failed',
    ]);
    expect([...PREVIEW_BUILD_STATUSES]).toEqual(['queued', 'building', 'succeeded', 'failed']);
    expect(previewStateSchema.safeParse('paused').success).toBe(false);
  });

  describe('a build', () => {
    const BUILD = {
      id: '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10',
      commit: 'a'.repeat(40),
      status: 'queued',
      requestedAt: '2026-11-24T10:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      timeLimitMinutes: 20,
      failure: null,
      log: { bytes: 0, truncated: false },
    };

    it('is accepted queued, and failed with its failure and refusals', () => {
      expect(previewBuildSchema.safeParse(BUILD).success).toBe(true);
      expect(
        previewBuildSchema.safeParse({
          ...BUILD,
          status: 'failed',
          startedAt: '2026-11-24T10:01:00.000Z',
          finishedAt: '2026-11-24T10:02:00.000Z',
          failure: {
            code: 'validation_refused',
            detail: 'refused',
            refusals: [{ code: 'privileged', place: 'services.web.privileged', message: 'No.' }],
            previewRemoved: true,
          },
        }).success,
      ).toBe(true);
    });

    it('refuses a status or a failure code it does not know, and a field it does not list', () => {
      expect(previewBuildSchema.safeParse({ ...BUILD, status: 'claimed' }).success).toBe(false);
      expect(
        previewBuildSchema.safeParse({
          ...BUILD,
          failure: { code: 'exploded', detail: '', refusals: [], previewRemoved: false },
        }).success,
      ).toBe(false);
      expect(previewBuildSchema.safeParse({ ...BUILD, extra: 1 }).success).toBe(false);
    });

    it('takes the three codes the API alone sets', () => {
      for (const code of ['controller_lost', 'not_claimed', 'report_overdue']) {
        expect(
          previewBuildSchema.safeParse({
            ...BUILD,
            status: 'failed',
            failure: { code, detail: '', refusals: [], previewRemoved: false },
          }).success,
        ).toBe(true);
      }
    });
  });

  describe('a page of the log', () => {
    const EVENT = {
      seq: 1,
      at: '2026-11-24T10:00:00.000Z',
      stream: 'build',
      text: 'step 1/3',
      truncated: false,
      redacted: false,
    };

    it('has the lines, final and truncated, and next only while lines remain', () => {
      expect(
        previewBuildEventsSchema.safeParse({ events: [EVENT], final: false, truncated: false })
          .success,
      ).toBe(true);
      expect(
        previewBuildEventsSchema.safeParse({
          events: [EVENT],
          next: 1,
          final: true,
          truncated: true,
        }).success,
      ).toBe(true);
      expect(previewBuildEventsSchema.safeParse({ events: [EVENT], final: false }).success).toBe(
        false,
      );
    });

    it('refuses a stream that is not one of the three', () => {
      expect(
        previewBuildEventsSchema.safeParse({
          events: [{ ...EVENT, stream: 'stderr' }],
          final: false,
          truncated: false,
        }).success,
      ).toBe(false);
    });
  });

  it('names the three refusals the settings flow adds', () => {
    for (const code of ['compose_file_missing', 'compose_file_too_large', 'invalid_path']) {
      expect(previewRefusalCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  describe('stop, reset and the list of Previews', () => {
    const CHANGE = {
      kind: 'reset_data',
      status: 'failed',
      requestedAt: '2026-11-24T10:00:00.000Z',
      finishedAt: '2026-11-24T10:01:00.000Z',
      failure: { code: 'runtime_failed', detail: 'Docker could not remove resources.' },
    };
    const PROJECT = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';

    it('describes the newest change and nothing else', () => {
      expect(previewLatestChangeSchema.safeParse(CHANGE).success).toBe(true);
      expect(previewLatestChangeSchema.safeParse({ ...CHANGE, kind: 'build' }).success).toBe(false);
      expect(previewLatestChangeSchema.safeParse({ ...CHANGE, extra: 1 }).success).toBe(false);
    });

    it('lists the limit and the Projects that take a place', () => {
      const list = { limit: 3, previews: [{ projectId: PROJECT, state: 'building' }] };
      expect(previewsListSchema.safeParse(list).success).toBe(true);
      expect(previewsListSchema.safeParse({ ...list, limit: undefined }).success).toBe(false);
    });

    it('names the running Projects in the limit problem', () => {
      const problem = {
        type: 'urn:agentic-studio:problem:preview-limit-reached',
        title: 'Preview limit reached',
        status: 409,
        detail: 'At most 3 Previews run at the same time.',
        correlationId: 'c1',
        running: [{ projectId: PROJECT, name: 'Shop', state: 'running' }],
      };
      expect(previewLimitReachedProblemSchema.safeParse(problem).success).toBe(true);
      expect(
        previewLimitReachedProblemSchema.safeParse({ ...problem, running: [{}] }).success,
      ).toBe(false);
    });
  });
});
