import { describe, expect, it, vi } from 'vitest';
import type {
  ReadRunSkillsHandler,
  ReadRunSkillsResult,
} from '../../../application/features/read-run-skills/handler.js';
import { ReadRunSkillsAgentSkills } from '../agent-skills.js';

const COMMIT = 'a'.repeat(40);

function adapter(result: ReadRunSkillsResult) {
  const execute = vi.fn(() => Promise.resolve(result));
  return {
    execute,
    skills: new ReadRunSkillsAgentSkills({ execute } as unknown as ReadRunSkillsHandler),
  };
}

describe('ReadRunSkillsAgentSkills', () => {
  const content = new Uint8Array([1]);
  const found: ReadRunSkillsResult = {
    status: 'found',
    skills: [
      {
        name: 'lint',
        description: 'Lints',
        files: [{ path: 'SKILL.md', executable: false, content }],
      },
    ],
    omitted: ['big'],
  };

  it('describes without files: name and description only, read without file content', async () => {
    const { skills, execute } = adapter(found);

    await expect(skills.describe(['lint'], COMMIT)).resolves.toEqual({
      status: 'found',
      skills: [{ name: 'lint', description: 'Lints' }],
    });
    expect(execute).toHaveBeenCalledWith({
      names: ['lint'],
      commit: COMMIT,
      include: 'descriptions',
    });
  });

  it('answers the files without descriptions, with the skills left out', async () => {
    const { skills, execute } = adapter(found);

    await expect(skills.files(['lint'], COMMIT)).resolves.toEqual({
      status: 'found',
      skills: [{ name: 'lint', files: [{ path: 'SKILL.md', executable: false, content }] }],
      omitted: ['big'],
    });
    expect(execute).toHaveBeenCalledWith({ names: ['lint'], commit: COMMIT, include: 'files' });
  });

  it('passes a refusal on as it is', async () => {
    const invalid: ReadRunSkillsResult = {
      status: 'invalid',
      problems: [{ skill: 'lint', code: 'shell_line', path: 'SKILL.md' }],
    };

    await expect(adapter(invalid).skills.describe(['lint'], COMMIT)).resolves.toEqual(invalid);
    await expect(
      adapter({ status: 'unavailable' }).skills.files(['lint'], COMMIT),
    ).resolves.toEqual({
      status: 'unavailable',
    });
  });
});
