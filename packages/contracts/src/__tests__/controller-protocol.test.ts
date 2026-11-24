import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appendOperationLogRequestSchema,
  claimOperationRequestSchema,
  CONTROLLER_PROBLEM_TYPES,
  CONTROLLER_REPORTABLE_FAILURE_CODES,
  operationPayloadSchema,
  operationSourceQuerySchema,
  PREVIEW_LOG_BATCH_MAX_BYTES,
  PREVIEW_LOG_LINE_MAX_BYTES,
  PREVIEW_OPERATION_FAILURE_CODES,
  PREVIEW_OPERATION_KINDS,
  reportOperationStateRequestSchema,
} from '../index.js';

const controllerId = randomUUID();
const operationId = randomUUID();
const projectId = randomUUID();
const composeProject = `preview-${projectId.replaceAll('-', '')}`;
const AT = '2026-11-24T10:00:00.000Z';

const line = (seq: number, text = 'step 1/3') => ({ seq, at: AT, stream: 'build', text });

describe('the controller protocol', () => {
  it('has exactly the four operations', () => {
    expect(PREVIEW_OPERATION_KINDS).toEqual(['build', 'stop', 'remove_data', 'state']);
  });

  it('lets the API alone record controller_lost', () => {
    expect(PREVIEW_OPERATION_FAILURE_CODES).toContain('controller_lost');
    expect(CONTROLLER_REPORTABLE_FAILURE_CODES).not.toContain('controller_lost');
    expect(PREVIEW_OPERATION_FAILURE_CODES).toHaveLength(15);
  });

  it('names the four problem types', () => {
    expect(Object.keys(CONTROLLER_PROBLEM_TYPES).sort()).toEqual([
      'operationNotFound',
      'operationNotHeld',
      'sourceTooLarge',
      'sourceUnavailable',
    ]);
  });

  describe('claim', () => {
    it('takes a controller id and nothing else', () => {
      expect(claimOperationRequestSchema.safeParse({ controllerId }).success).toBe(true);
      expect(claimOperationRequestSchema.safeParse({ controllerId: 'x' }).success).toBe(false);
      expect(claimOperationRequestSchema.safeParse({ controllerId, extra: 1 }).success).toBe(false);
    });

    const build = {
      operationId,
      projectId,
      composeProject,
      kind: 'build',
      commit: 'a'.repeat(40),
      composeFile: 'compose.yaml',
      service: 'web',
      port: 3000,
      environmentFile: { path: '.env', content: 'A=b' },
      limits: { memoryMiB: 1024, cpuPercent: 100, tasksMax: 512, buildMinutes: 20 },
    };

    it('describes a build with its limits and Environment file, or none', () => {
      expect(operationPayloadSchema.safeParse(build).success).toBe(true);
      expect(operationPayloadSchema.safeParse({ ...build, environmentFile: null }).success).toBe(
        true,
      );
    });

    it('describes the other operations with no further fields', () => {
      for (const kind of ['stop', 'remove_data', 'state']) {
        expect(
          operationPayloadSchema.safeParse({ operationId, projectId, composeProject, kind })
            .success,
        ).toBe(true);
        expect(
          operationPayloadSchema.safeParse({
            operationId,
            projectId,
            composeProject,
            kind,
            command: 'ls',
          }).success,
        ).toBe(false);
      }
    });

    it.each([
      ['a Compose project that is not preview-<32 hex>', { composeProject: 'preview-x' }],
      ['a short commit', { commit: 'abc' }],
      ['memory under the bound', { limits: { ...build.limits, memoryMiB: 127 } }],
      ['cpu over the bound', { limits: { ...build.limits, cpuPercent: 6401 } }],
      ['tasks under the bound', { limits: { ...build.limits, tasksMax: 63 } }],
      ['a build time over the bound', { limits: { ...build.limits, buildMinutes: 121 } }],
      ['an unknown field', { image: 'x' }],
    ])('refuses %s', (_case, change) => {
      expect(operationPayloadSchema.safeParse({ ...build, ...change }).success).toBe(false);
    });
  });

  describe('state report', () => {
    const base = { controllerId };

    it('takes in_progress, succeeded and failed', () => {
      expect(
        reportOperationStateRequestSchema.safeParse({ ...base, state: 'in_progress' }).success,
      ).toBe(true);
      expect(
        reportOperationStateRequestSchema.safeParse({
          ...base,
          state: 'succeeded',
          runtime: { services: [{ name: 'web', state: 'running' }] },
        }).success,
      ).toBe(true);
      expect(
        reportOperationStateRequestSchema.safeParse({
          ...base,
          state: 'failed',
          failure: { code: 'build_failed', detail: 'exit 1' },
        }).success,
      ).toBe(true);
    });

    it('requires a failure with failed, and allows it with no other state', () => {
      expect(
        reportOperationStateRequestSchema.safeParse({ ...base, state: 'failed' }).success,
      ).toBe(false);
      expect(
        reportOperationStateRequestSchema.safeParse({
          ...base,
          state: 'succeeded',
          failure: { code: 'build_failed', detail: 'x' },
        }).success,
      ).toBe(false);
    });

    it('refuses controller_lost from the controller, a long detail and too many refusals', () => {
      const failed = (failure: object) =>
        reportOperationStateRequestSchema.safeParse({ ...base, state: 'failed', failure }).success;
      expect(failed({ code: 'controller_lost', detail: 'x' })).toBe(false);
      expect(failed({ code: 'build_failed', detail: 'x'.repeat(2001) })).toBe(false);
      const refusal = { code: 'privileged', place: 'services.web', message: 'No.' };
      expect(
        failed({
          code: 'validation_refused',
          detail: 'x',
          refusals: Array.from({ length: 100 }, () => refusal),
        }),
      ).toBe(true);
      expect(
        failed({
          code: 'validation_refused',
          detail: 'x',
          refusals: Array.from({ length: 101 }, () => refusal),
        }),
      ).toBe(false);
    });

    it('allows a runtime with succeeded only, and at most 100 services', () => {
      const runtime = { services: [{ name: 'web', state: 'running' }] };
      expect(
        reportOperationStateRequestSchema.safeParse({ ...base, state: 'in_progress', runtime })
          .success,
      ).toBe(false);
      expect(
        reportOperationStateRequestSchema.safeParse({
          ...base,
          state: 'succeeded',
          runtime: {
            services: Array.from({ length: 101 }, (_, i) => ({ name: `s${i}`, state: 'running' })),
          },
        }).success,
      ).toBe(false);
    });
  });

  describe('log batch', () => {
    const batch = (lines: unknown[]) =>
      appendOperationLogRequestSchema.safeParse({ controllerId, lines }).success;

    it('takes 1 to 100 lines with strictly increasing seq', () => {
      expect(batch([line(1), line(2), line(7)])).toBe(true);
      expect(batch([])).toBe(false);
      expect(batch(Array.from({ length: 100 }, (_, i) => line(i + 1)))).toBe(true);
      expect(batch(Array.from({ length: 101 }, (_, i) => line(i + 1)))).toBe(false);
      expect(batch([line(2), line(2)])).toBe(false);
      expect(batch([line(3), line(2)])).toBe(false);
      expect(batch([line(0)])).toBe(false);
    });

    it('cuts a line at 2048 bytes, counted in UTF-8 bytes', () => {
      expect(batch([line(1, 'a'.repeat(PREVIEW_LOG_LINE_MAX_BYTES))])).toBe(true);
      expect(batch([line(1, 'a'.repeat(PREVIEW_LOG_LINE_MAX_BYTES + 1))])).toBe(false);
      expect(batch([line(1, 'é'.repeat(PREVIEW_LOG_LINE_MAX_BYTES / 2 + 1))])).toBe(false);
    });

    it('holds at most 64 KiB of text', () => {
      const full = Array.from({ length: PREVIEW_LOG_BATCH_MAX_BYTES / 1024 }, (_, i) =>
        line(i + 1, 'a'.repeat(1024)),
      );
      expect(batch(full)).toBe(true);
      expect(batch([...full, line(999, 'b')])).toBe(false);
    });

    it('refuses an unknown stream, a bad time and an unknown field', () => {
      expect(batch([{ ...line(1), stream: 'stdout' }])).toBe(false);
      expect(batch([{ ...line(1), at: 'yesterday' }])).toBe(false);
      expect(batch([{ ...line(1), extra: true }])).toBe(false);
    });
  });

  it('takes the controller id as the query of the source', () => {
    expect(operationSourceQuerySchema.safeParse({ controllerId }).success).toBe(true);
    expect(operationSourceQuerySchema.safeParse({}).success).toBe(false);
  });
});
