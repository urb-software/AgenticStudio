import { z } from 'zod';
import { RetentionDays } from './retention-days.js';

export class Task {
  static readonly schema = z.string().max(RetentionDays.DEFAULT);

  private constructor(readonly text: string) {}

  static of(text: string): Task {
    return new Task(Task.schema.parse(text));
  }
}
