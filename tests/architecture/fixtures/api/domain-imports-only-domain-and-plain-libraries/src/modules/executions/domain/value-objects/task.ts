import { z } from 'zod';
import { RETENTION_DAYS } from './retention-days.js';

export const taskSchema = z.string().max(RETENTION_DAYS);
