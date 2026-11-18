import { reviewCommentSchema } from '@agentic-studio/contracts';
import { z } from 'zod';

export const commentsSchema = z.array(reviewCommentSchema);
