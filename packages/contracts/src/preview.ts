import { z } from 'zod';

/** Longest Compose file path, in characters, and longest Compose service name. */
export const PREVIEW_COMPOSE_FILE_MAX_LENGTH = 255;
export const PREVIEW_SERVICE_MAX_LENGTH = 63;
export const PREVIEW_PORT_MIN = 1;
export const PREVIEW_PORT_MAX = 65535;

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

/** What the Preview page shows: the settings, the hostname and whether the Repository can be read. */
export const previewSchema = z.strictObject({
  settings: previewSettingsSchema.nullable(),
  /** `null` while no preview domain is configured. */
  hostname: z.string().nullable(),
  hostnameUnavailable: z.enum(['not_configured']).optional(),
  repository: z.strictObject({
    ready: z.boolean(),
    reason: previewRepositoryReasonSchema.optional(),
  }),
});
export type Preview = z.infer<typeof previewSchema>;

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
