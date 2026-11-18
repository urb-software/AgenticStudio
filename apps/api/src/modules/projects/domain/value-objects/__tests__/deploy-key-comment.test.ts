import { describe, expect, it } from 'vitest';
import { DeployKeyComment } from '../deploy-key-comment.js';

describe('DeployKeyComment.of', () => {
  it.each([
    ['Acme Shop', 'studio-Acme-Shop'],
    ['  shop  ', 'studio-shop'],
    ['café / api', 'studio-caf-api'],
    ['a.b_c-d', 'studio-a.b_c-d'],
    ['$(rm -rf)', 'studio-rm-rf'],
    ['ü', 'studio-project'],
    ['x'.repeat(100), `studio-${'x'.repeat(64)}`],
  ])('turns %j into %j', (name, comment) => {
    expect(DeployKeyComment.of(name).value).toBe(comment);
  });
});
