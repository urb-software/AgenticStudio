import { GenericContainer } from 'testcontainers';
import { describe, expect, it } from 'vitest';
import { RetentionPolicy } from '../retention-policy.js';

describe('RetentionPolicy', () => {
  it('needs no container', async () => {
    const container = await new GenericContainer('postgres:18').start();
    expect(new RetentionPolicy(7).days).toBe(7);
    await container.stop();
  });
});
