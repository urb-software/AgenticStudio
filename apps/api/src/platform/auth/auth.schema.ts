import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Login request. The cap bounds hashing work; the password is never logged or echoed. */
export const loginRequestSchema = z
  .object({ password: z.string().min(1).max(1024) })
  .meta({ id: 'LoginRequest' });

export class LoginRequestDto extends createZodDto(loginRequestSchema) {}

/** Non-secret authentication indication for the UI. */
export const sessionResponseSchema = z
  .object({ authenticated: z.literal(true) })
  .meta({ id: 'SessionResponse' });

export class SessionResponseDto extends createZodDto(sessionResponseSchema) {}
