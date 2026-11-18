import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Longest accepted fingerprint; `SHA256:` plus 43 base64 characters is 50. */
export const HOST_KEY_FINGERPRINT_MAX_LENGTH = 100;

/**
 * `POST /api/projects/:id/repository/verify` body: `{}` to verify the Deploy key and start the
 * clone, or the confirmed fingerprint when `awaiting_host_key`. A violation or unknown field is a 422.
 */
export const verifyRepositoryRequestSchema = z
  .strictObject({
    acceptHostKeyFingerprint: z
      .string()
      .trim()
      .min(1, { error: 'Enter the host key fingerprint.', abort: true })
      .max(HOST_KEY_FINGERPRINT_MAX_LENGTH, {
        error: `Use at most ${HOST_KEY_FINGERPRINT_MAX_LENGTH} characters.`,
      })
      .optional()
      .meta({
        description:
          'The SHA256 fingerprint (`SHA256:…`) of the host key the operator confirmed; it must ' +
          'equal the `hostKeyFingerprint` of the `awaiting_host_key` repository exactly.',
      }),
  })
  .meta({ id: 'VerifyRepositoryRequest' });

export class VerifyRepositoryRequestDto extends createZodDto(verifyRepositoryRequestSchema) {}

export type VerifyRepositoryRequest = z.infer<typeof verifyRepositoryRequestSchema>;
