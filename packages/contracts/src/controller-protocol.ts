import { z } from 'zod';
import {
  CONTROLLER_REPORTABLE_FAILURE_CODES,
  PREVIEW_OPERATION_FAILURE_CODES,
} from './preview-failure-codes.js';
import { previewRefusalSchema } from './preview.js';

export {
  API_ONLY_FAILURE_CODES,
  CONTROLLER_REPORTABLE_FAILURE_CODES,
  PREVIEW_OPERATION_FAILURE_CODES,
} from './preview-failure-codes.js';

/**
 * The Studio/environment-controller wire protocol under `/api/controller/`: the API validates
 * every controller request, the controller every response.
 */

/** What the controller can be asked to do with one Project's Preview: nothing else exists. */
export const PREVIEW_OPERATION_KINDS = ['build', 'stop', 'remove_data', 'state'] as const;
export const previewOperationKindSchema = z.enum(PREVIEW_OPERATION_KINDS);
export type PreviewOperationKind = z.infer<typeof previewOperationKindSchema>;

/** Where a log line came from. */
export const PREVIEW_LOG_STREAMS = ['build', 'start', 'controller'] as const;
export const previewLogStreamSchema = z.enum(PREVIEW_LOG_STREAMS);
export type PreviewLogStream = z.infer<typeof previewLogStreamSchema>;

/** What the controller reports about an operation it holds. */
export const PREVIEW_REPORTED_STATES = ['in_progress', 'succeeded', 'failed'] as const;
export const previewReportedStateSchema = z.enum(PREVIEW_REPORTED_STATES);
export type PreviewReportedState = z.infer<typeof previewReportedStateSchema>;

export const previewOperationFailureCodeSchema = z.enum(PREVIEW_OPERATION_FAILURE_CODES);
export type PreviewOperationFailureCode = z.infer<typeof previewOperationFailureCodeSchema>;

/** Longest failure detail, in characters. */
export const PREVIEW_FAILURE_DETAIL_MAX_LENGTH = 2000;
export const PREVIEW_FAILURE_REFUSALS_MAX = 100;
export const PREVIEW_RUNTIME_SERVICES_MAX = 100;

/** A log line is cut to this many UTF-8 bytes; a batch holds at most these lines and bytes. */
export const PREVIEW_LOG_LINE_MAX_BYTES = 2048;
export const PREVIEW_LOG_BATCH_MAX_LINES = 100;
export const PREVIEW_LOG_BATCH_MAX_BYTES = 64 * 1024;

/**
 * Largest request body of a log batch: 64 KiB of text escaped as six bytes per control character,
 * plus the lines' fields.
 */
export const PREVIEW_LOG_REQUEST_MAX_BYTES = 512 * 1024;

/** The source archive of a build: at most this many bytes and entries. */
export const PREVIEW_ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
export const PREVIEW_ARCHIVE_MAX_ENTRIES = 50_000;

/** Bounds of the per-build limits, the one list for the API's settings and the controller. */
export const PREVIEW_LIMIT_BOUNDS = {
  memoryMiB: { min: 128, max: 65_536 },
  cpuPercent: { min: 10, max: 6400 },
  tasksMax: { min: 64, max: 32_768 },
  buildMinutes: { min: 1, max: 120 },
} as const;

/** Problem `type`s the controller reacts to; pinned to the API's list by a test. */
export const CONTROLLER_PROBLEM_TYPES = {
  operationNotFound: 'urn:agentic-studio:problem:preview-operation-not-found',
  operationNotHeld: 'urn:agentic-studio:problem:preview-operation-not-held',
  sourceUnavailable: 'urn:agentic-studio:problem:preview-operation-source-unavailable',
  sourceTooLarge: 'urn:agentic-studio:problem:preview-operation-source-too-large',
  operationNotABuild: 'urn:agentic-studio:problem:preview-operation-not-a-build',
} as const;

/** The Compose project name of a Preview: derived from the Project's id. */
export const PREVIEW_COMPOSE_PROJECT_PATTERN = /^preview-[0-9a-f]{32}$/;

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** The hostname label of a Preview, the controller's socket name; never derived by the controller. */
export const PREVIEW_LABEL_PATTERN = /^preview-[0-9a-f]{12}$/;

/** Identifies one controller process; it generates a random UUID when it starts. */
const controllerIdSchema = z.uuid();

/** `POST /api/controller/operations/claim` body. */
export const claimOperationRequestSchema = z.strictObject({ controllerId: controllerIdSchema });
export type ClaimOperationRequest = z.infer<typeof claimOperationRequestSchema>;

const limitsSchema = z.strictObject({
  memoryMiB: z
    .number()
    .int()
    .min(PREVIEW_LIMIT_BOUNDS.memoryMiB.min)
    .max(PREVIEW_LIMIT_BOUNDS.memoryMiB.max),
  cpuPercent: z
    .number()
    .int()
    .min(PREVIEW_LIMIT_BOUNDS.cpuPercent.min)
    .max(PREVIEW_LIMIT_BOUNDS.cpuPercent.max),
  tasksMax: z
    .number()
    .int()
    .min(PREVIEW_LIMIT_BOUNDS.tasksMax.min)
    .max(PREVIEW_LIMIT_BOUNDS.tasksMax.max),
  buildMinutes: z
    .number()
    .int()
    .min(PREVIEW_LIMIT_BOUNDS.buildMinutes.min)
    .max(PREVIEW_LIMIT_BOUNDS.buildMinutes.max),
});
export type PreviewBuildLimits = z.infer<typeof limitsSchema>;

/** Largest Environment file content, in UTF-8 bytes (the Environment file's own limit). */
const ENVIRONMENT_FILE_CONTENT_MAX_BYTES = 64 * 1024;

const environmentFileSchema = z.strictObject({
  path: z.string().min(1).max(255),
  content: z.string().refine((value) => utf8Length(value) <= ENVIRONMENT_FILE_CONTENT_MAX_BYTES),
});

const operationBaseShape = {
  operationId: z.uuid(),
  projectId: z.uuid(),
  composeProject: z.string().regex(PREVIEW_COMPOSE_PROJECT_PATTERN),
  previewLabel: z.string().regex(PREVIEW_LABEL_PATTERN),
};

/**
 * `POST /api/controller/operations/claim` answer (200): the claimed operation. Only the holder
 * receives a build's Environment file, and it is never logged.
 */
export const operationPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...operationBaseShape,
    kind: z.literal('build'),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    composeFile: z.string().min(1).max(255),
    service: z.string().min(1).max(63),
    port: z.number().int().min(1).max(65_535),
    environmentFile: environmentFileSchema.nullable(),
    limits: limitsSchema,
  }),
  z.strictObject({ ...operationBaseShape, kind: z.literal('stop') }),
  z.strictObject({ ...operationBaseShape, kind: z.literal('remove_data') }),
  z.strictObject({ ...operationBaseShape, kind: z.literal('state') }),
]);
export type OperationPayload = z.infer<typeof operationPayloadSchema>;

const failureSchema = z.strictObject({
  code: z.enum(CONTROLLER_REPORTABLE_FAILURE_CODES),
  detail: z.string().max(PREVIEW_FAILURE_DETAIL_MAX_LENGTH),
  refusals: z.array(previewRefusalSchema).max(PREVIEW_FAILURE_REFUSALS_MAX).optional(),
  /** True when the failure removed the Project's running Preview (the rollback after `up`). */
  previewRemoved: z.boolean().optional(),
});
export type OperationFailure = z.infer<typeof failureSchema>;

const runtimeSchema = z.strictObject({
  services: z
    .array(z.strictObject({ name: z.string().min(1).max(255), state: z.string().min(1).max(64) }))
    .max(PREVIEW_RUNTIME_SERVICES_MAX),
});
export type OperationRuntime = z.infer<typeof runtimeSchema>;

/**
 * `POST /api/controller/operations/:id/state` body. An `in_progress` report every 15 seconds is
 * the heartbeat; a failure comes with `failed` only, the runtime with `succeeded` only.
 */
export const reportOperationStateRequestSchema = z
  .strictObject({
    controllerId: controllerIdSchema,
    state: previewReportedStateSchema,
    failure: failureSchema.optional(),
    runtime: runtimeSchema.optional(),
  })
  .refine((body) => (body.state === 'failed') === (body.failure !== undefined), {
    message: 'a failure is required with state failed and allowed with no other state',
    path: ['failure'],
  })
  .refine((body) => body.runtime === undefined || body.state === 'succeeded', {
    message: 'a runtime is allowed with state succeeded only',
    path: ['runtime'],
  });
export type ReportOperationStateRequest = z.infer<typeof reportOperationStateRequestSchema>;

const logLineSchema = z.strictObject({
  seq: z.number().int().min(1),
  at: z.iso.datetime({ offset: true }),
  stream: previewLogStreamSchema,
  text: z.string().refine((value) => utf8Length(value) <= PREVIEW_LOG_LINE_MAX_BYTES, {
    message: `a line is at most ${PREVIEW_LOG_LINE_MAX_BYTES} bytes`,
  }),
  truncated: z.boolean().optional(),
});
export type OperationLogLine = z.infer<typeof logLineSchema>;

/** `POST /api/controller/operations/:id/log` body: 1 to 100 lines, `seq` strictly increasing. */
export const appendOperationLogRequestSchema = z
  .strictObject({
    controllerId: controllerIdSchema,
    lines: z.array(logLineSchema).min(1).max(PREVIEW_LOG_BATCH_MAX_LINES),
  })
  .refine((body) => body.lines.every((line, i) => i === 0 || line.seq > body.lines[i - 1]!.seq), {
    message: 'seq must be strictly increasing',
    path: ['lines'],
  })
  .refine(
    (body) =>
      body.lines.reduce((sum, line) => sum + utf8Length(line.text), 0) <=
      PREVIEW_LOG_BATCH_MAX_BYTES,
    {
      message: `a batch holds at most ${PREVIEW_LOG_BATCH_MAX_BYTES} bytes of text`,
      path: ['lines'],
    },
  );
export type AppendOperationLogRequest = z.infer<typeof appendOperationLogRequestSchema>;

/** `POST /api/controller/operations/:id/log` answer: `truncated` once the cap is reached. */
export const appendOperationLogResponseSchema = z.strictObject({
  stored: z.number().int().min(0),
  truncated: z.boolean(),
});
export type AppendOperationLogResponse = z.infer<typeof appendOperationLogResponseSchema>;

/** `GET /api/controller/operations/:id/source?controllerId=` query. */
export const operationSourceQuerySchema = z.strictObject({ controllerId: controllerIdSchema });
export type OperationSourceQuery = z.infer<typeof operationSourceQuerySchema>;
