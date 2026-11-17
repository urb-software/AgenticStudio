import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { RetentionPolicy } from '../retention-policy.js';

describe('RetentionPolicy', () => {
  it('needs no database', () => {
    expect(new PrismaClient()).toBeDefined();
    expect(new RetentionPolicy(7).days).toBe(7);
  });
});
