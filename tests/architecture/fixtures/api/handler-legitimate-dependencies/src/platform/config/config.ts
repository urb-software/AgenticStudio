import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

export const AppConfigSchema = z.object({ maxProjects: z.number() });
export type AppConfig = z.infer<typeof AppConfigSchema>;
