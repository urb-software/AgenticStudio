import { describe, expect, it } from 'vitest';
import { SkillsRefusal } from '../skills-refusal.js';

describe('SkillsRefusal', () => {
  it('names skills, codes and paths only, the skill alone for a problem of the folder', () => {
    expect(
      SkillsRefusal.of([
        { skill: 'lint', code: 'shell_line', path: 'SKILL.md' },
        { skill: 'notes', code: 'too_many_files', path: '' },
      ]).detail,
    ).toBe(
      "The agent's skills fail the validation: shell_line (lint/SKILL.md), too_many_files (notes).",
    );
  });

  it('lists at most ten problems', () => {
    const problems = Array.from({ length: 12 }, (_, i) => ({
      skill: `s${i}`,
      code: 'x',
      path: '',
    }));

    expect(SkillsRefusal.of(problems).detail.split('),').length).toBe(10);
  });
});
