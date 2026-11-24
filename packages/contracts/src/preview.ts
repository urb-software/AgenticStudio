import { z } from 'zod';
import { PREVIEW_OPERATION_FAILURE_CODES } from './preview-failure-codes.js';

/** Longest Compose file path, in characters, and longest Compose service name. */
export const PREVIEW_COMPOSE_FILE_MAX_LENGTH = 255;
export const PREVIEW_SERVICE_MAX_LENGTH = 63;
export const PREVIEW_PORT_MIN = 1;
export const PREVIEW_PORT_MAX = 65535;

/** The most Previews that run at the same time is a whole number within these bounds. */
export const PREVIEW_MAX_RUNNING_BOUNDS = { min: 1, max: 50 } as const;

/** The Compose service-name rule. */
export const PREVIEW_SERVICE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Every reason a Preview's settings are refused: the Compose validation's codes, and the three
 * the settings flow adds. Pinned to the validation package by a test in the API.
 */
export const PREVIEW_REFUSAL_CODES = [
  'text_too_large',
  'too_many_nodes',
  'too_many_services',
  'yaml_syntax',
  'custom_tag',
  'not_a_mapping',
  'duplicate_key',
  'alias_limit',
  'unjudgeable',
  'unknown_key',
  'invalid_value',
  'interpolation',
  'privileged',
  'host_namespace',
  'capability_added',
  'device',
  'mount_outside_source',
  'docker_socket',
  'external_network',
  'external_volume',
  'path_outside_source',
  'build_context_not_local',
  'external_file',
  'entry_service_missing',
  'entry_port_invalid',
  'compose_file_missing',
  'compose_file_too_large',
  'invalid_path',
] as const;
export const previewRefusalCodeSchema = z.enum(PREVIEW_REFUSAL_CODES);
export type PreviewRefusalCode = z.infer<typeof previewRefusalCodeSchema>;

export const previewRefusalSchema = z.strictObject({
  code: previewRefusalCodeSchema,
  /** A path into the Compose file (`services.web.volumes[1]`), or the request field (`composeFile`). */
  place: z.string(),
  /** Fixed wording per code; never a value from the file. */
  message: z.string(),
});
export type PreviewRefusal = z.infer<typeof previewRefusalSchema>;

/** `PUT /api/projects/:id/preview/settings` body. Only the shape is checked here; the file is judged by the API. */
export const savePreviewSettingsRequestSchema = z.strictObject({
  composeFile: z
    .string()
    .max(PREVIEW_COMPOSE_FILE_MAX_LENGTH)
    .describe(
      'Relative POSIX path of the Compose file in the Integration branch, at most 255 characters: ' +
        'no leading `/` or `./`, no `..`, backslash or empty segment.',
    ),
  service: z
    .string()
    .max(PREVIEW_SERVICE_MAX_LENGTH)
    .regex(PREVIEW_SERVICE_PATTERN)
    .describe('The Compose service the Preview routes to.'),
  port: z
    .int()
    .min(PREVIEW_PORT_MIN)
    .max(PREVIEW_PORT_MAX)
    .describe('The port of that service the Preview routes to.'),
});
export type SavePreviewSettingsRequest = z.infer<typeof savePreviewSettingsRequestSchema>;

export const PREVIEW_REPOSITORY_REASONS = [
  'no_repository',
  'repository_not_ready',
  'unsupported_platform',
] as const;
export const previewRepositoryReasonSchema = z.enum(PREVIEW_REPOSITORY_REASONS);
export type PreviewRepositoryReason = z.infer<typeof previewRepositoryReasonSchema>;

export const previewSettingsSchema = z.strictObject({
  composeFile: z.string(),
  service: z.string(),
  port: z.int(),
  updatedAt: z.iso.datetime(),
});

/**
 * What the Preview is. `resetting_data` and `stopping` while that change is requested or claimed,
 * then `building` while a build is, and so on down the list the state is picked from.
 */
export const PREVIEW_STATES = [
  'not_configured',
  'stopped',
  'stopping',
  'resetting_data',
  'building',
  'running',
  'failed',
] as const;
export const previewStateSchema = z.enum(PREVIEW_STATES);
export type PreviewState = z.infer<typeof previewStateSchema>;

/** `queued` waits for the controller, `building` is claimed, the other two are final. */
export const PREVIEW_BUILD_STATUSES = ['queued', 'building', 'succeeded', 'failed'] as const;
export const previewBuildStatusSchema = z.enum(PREVIEW_BUILD_STATUSES);
export type PreviewBuildStatus = z.infer<typeof previewBuildStatusSchema>;

export const previewBuildFailureSchema = z.strictObject({
  code: z.enum(PREVIEW_OPERATION_FAILURE_CODES),
  detail: z.string(),
  refusals: z.array(previewRefusalSchema),
  /** True when the failed build also stopped the Preview that was running. */
  previewRemoved: z.boolean(),
});
export type PreviewBuildFailure = z.infer<typeof previewBuildFailureSchema>;

/** One build of the Project's Preview. */
export const previewBuildSchema = z.strictObject({
  id: z.uuid(),
  commit: z.string(),
  status: previewBuildStatusSchema,
  requestedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  timeLimitMinutes: z.int(),
  failure: previewBuildFailureSchema.nullable(),
  log: z.strictObject({ bytes: z.int(), truncated: z.boolean() }),
});
export type PreviewBuild = z.infer<typeof previewBuildSchema>;

export const PREVIEW_CHANGE_KINDS = ['stop', 'reset_data'] as const;
export const previewChangeKindSchema = z.enum(PREVIEW_CHANGE_KINDS);
export type PreviewChangeKind = z.infer<typeof previewChangeKindSchema>;

/** `queued` waits for the controller, `in_progress` is claimed, the other two are final. */
export const PREVIEW_CHANGE_STATUSES = ['queued', 'in_progress', 'succeeded', 'failed'] as const;
export const previewChangeStatusSchema = z.enum(PREVIEW_CHANGE_STATUSES);
export type PreviewChangeStatus = z.infer<typeof previewChangeStatusSchema>;

/** The newest Stop or Reset of the Project's Preview. */
export const previewLatestChangeSchema = z.strictObject({
  kind: previewChangeKindSchema,
  status: previewChangeStatusSchema,
  requestedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  failure: z
    .strictObject({ code: z.enum(PREVIEW_OPERATION_FAILURE_CODES), detail: z.string() })
    .nullable(),
});
export type PreviewLatestChange = z.infer<typeof previewLatestChangeSchema>;

/** What the Preview page shows: the settings, the hostname, the state and the latest build. */
export const previewSchema = z.strictObject({
  settings: previewSettingsSchema.nullable(),
  /** `null` while no preview domain is configured. */
  hostname: z.string().nullable(),
  hostnameUnavailable: z.enum(['not_configured']).optional(),
  repository: z.strictObject({
    ready: z.boolean(),
    reason: previewRepositoryReasonSchema.optional(),
    /** The commit the Clone holds, when the Repository is ready. */
    commit: z.string().optional(),
  }),
  state: previewStateSchema,
  /** The build Studio last asked to run; `url` is `null` while no preview domain is configured. */
  running: z
    .strictObject({
      buildId: z.uuid(),
      commit: z.string(),
      since: z.iso.datetime(),
      url: z.string().nullable(),
    })
    .nullable(),
  latestBuild: previewBuildSchema.nullable(),
  /** The newest Stop or Reset, so a failed one stays visible; `null` when there was none. */
  latestChange: previewLatestChangeSchema.nullable(),
  controller: z.strictObject({ connected: z.boolean() }),
});
export type Preview = z.infer<typeof previewSchema>;

/** The Projects whose Preview takes one of the places: running, or with a build requested or claimed. */
export const previewsListSchema = z.strictObject({
  /** The most Previews that run at the same time. */
  limit: z.int(),
  previews: z.array(z.strictObject({ projectId: z.uuid(), state: previewStateSchema })),
});
export type PreviewsList = z.infer<typeof previewsListSchema>;

/** The 409 of a build refused because every place is taken. */
export const previewLimitReachedProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  detail: z.string(),
  correlationId: z.string(),
  running: z.array(
    z.strictObject({ projectId: z.uuid(), name: z.string(), state: previewStateSchema }),
  ),
});
export type PreviewLimitReachedProblem = z.infer<typeof previewLimitReachedProblemSchema>;

export const removedPortSchema = z.strictObject({ service: z.string(), place: z.string() });

/** The answer of a save: the Preview, and the published ports the validation removed (when any). */
export const savePreviewSettingsResponseSchema = previewSchema.extend({
  removedPorts: z.array(removedPortSchema).optional(),
});
export type SavePreviewSettingsResponse = z.infer<typeof savePreviewSettingsResponseSchema>;

/** The 422 of a save: the file or the choice was refused, with every reason found. */
export const previewRefusedProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int(),
  detail: z.string(),
  correlationId: z.string(),
  refusals: z.array(previewRefusalSchema),
});
export type PreviewRefusedProblem = z.infer<typeof previewRefusedProblemSchema>;

export const PREVIEW_EVENTS_DEFAULT_LIMIT = 500;
export const PREVIEW_EVENTS_MAX_LIMIT = 1000;

export const previewBuildEventSchema = z.strictObject({
  seq: z.int(),
  at: z.iso.datetime(),
  stream: z.enum(['build', 'start', 'controller']),
  text: z.string(),
  truncated: z.boolean(),
  /** Whether the text holds the redaction marker. */
  redacted: z.boolean(),
});
export type PreviewBuildEvent = z.infer<typeof previewBuildEventSchema>;

/** A page of a build's log: `next` is the `after` of the following page, absent on the last. */
export const previewBuildEventsSchema = z.strictObject({
  events: z.array(previewBuildEventSchema),
  next: z.int().optional(),
  /** True once the build is over: no line will be added. */
  final: z.boolean(),
  /** True when the log reached its size cap. */
  truncated: z.boolean(),
});
export type PreviewBuildEvents = z.infer<typeof previewBuildEventsSchema>;
