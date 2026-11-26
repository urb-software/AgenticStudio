import { describe, expect, it, vi } from 'vitest';
import type { ReadSkillsHandler } from '../../../../../application/features/read-skills/handler.js';
import { ListSkillsEndpoint } from '../endpoint.js';
import { skillListResponseSchema } from '../schema.js';

const COMMIT = 'a'.repeat(40);

describe('ListSkillsEndpoint', () => {
  it('answers the commit, the cut flag and each skill with its problems, without instructions', async () => {
    const handler = {
      execute: vi.fn(() =>
        Promise.resolve({
          commit: COMMIT,
          repository: { state: 'ready' as const, note: null },
          truncated: true,
          skills: [
            {
              name: 'review',
              description: 'Reviews',
              valid: true,
              problems: [],
              instructions: 'Body',
              files: [{ path: 'SKILL.md', size: 4 }],
            },
            {
              name: 'bad',
              description: null,
              valid: false,
              problems: [
                {
                  code: 'forbidden_key' as const,
                  path: 'SKILL.md',
                  key: 'hooks',
                  message: 'The key "hooks" asks for tools.',
                },
                { code: 'entry_missing' as const, path: '', message: 'No entry file.' },
              ],
              instructions: '',
              files: [],
            },
          ],
        }),
      ),
    };
    const endpoint = new ListSkillsEndpoint(handler as unknown as ReadSkillsHandler);

    const answer = await endpoint.list();

    expect(skillListResponseSchema.parse(answer)).toEqual(answer);
    expect(answer).toEqual({
      commit: COMMIT,
      repository: { state: 'ready', note: null },
      truncated: true,
      skills: [
        { name: 'review', description: 'Reviews', valid: true, problems: [] },
        {
          name: 'bad',
          description: null,
          valid: false,
          problems: [
            {
              code: 'forbidden_key',
              path: 'SKILL.md',
              key: 'hooks',
              message: 'The key "hooks" asks for tools.',
            },
            { code: 'entry_missing', path: '', key: null, message: 'No entry file.' },
          ],
        },
      ],
    });
  });

  it('answers no repository and no skill when none is connected', async () => {
    const handler = {
      execute: vi.fn(() =>
        Promise.resolve({ commit: null, repository: null, truncated: false, skills: [] }),
      ),
    };
    const endpoint = new ListSkillsEndpoint(handler as unknown as ReadSkillsHandler);

    await expect(endpoint.list()).resolves.toEqual({
      commit: null,
      repository: null,
      truncated: false,
      skills: [],
    });
  });
});
