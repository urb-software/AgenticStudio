import { BASE_RULES } from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildInstructions,
  INSTRUCTIONS_TOTAL_MAX_BYTES,
  type InstructionsSource,
  type RepositoryFiles,
  type SkillEntry,
  SKILLS_SECTION_MAX_BYTES,
  skillsSection,
} from '../claude-code/instructions.js';
import { codexPrompt } from '../codex/cli-options.js';
import { agentFields } from './agent-fixtures.js';
import { golden, GOLDEN_MARKER, GOLDEN_REPOSITORY, goldenAgent } from './golden-files.js';

// The skills section: one section right after the agent's own, the same for both Providers.

const RUN_DIR = '/var/lib/studio-agent/runs/0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const entry = (name: string, description = `Does ${name}`): SkillEntry => ({
  name,
  description,
  entryFile: `${RUN_DIR}/skills/${name}/SKILL.md`,
});
const TWO: SkillEntry[] = [
  entry('lint', 'Lints the code and reports the findings.'),
  entry('release-notes', 'Writes release notes from the merged pull requests.'),
];
const bytes = (text: string) => new TextEncoder().encode(text).length;

const repository = (files: Record<string, string>): RepositoryFiles => ({
  read: async (path) => (Object.hasOwn(files, path) ? files[path]! : null),
});

const reviewer = (extra: Partial<InstructionsSource> = {}): InstructionsSource => {
  const base = agentFields();
  return {
    ...base,
    agent: { instructions: 'Review every change twice.\nPrefer small steps.\n' },
    ...extra,
  };
};

describe('a Run without skills', () => {
  it('gets the built-in Default agent file and prompt it always had, with an empty list too', async () => {
    for (const skills of [undefined, []]) {
      const claude = await buildInstructions(
        { ...agentFields(), ...(skills ? { skills } : {}) },
        repository(GOLDEN_REPOSITORY),
        GOLDEN_MARKER,
      );
      const codex = await buildInstructions(
        { ...agentFields(), ...(skills ? { skills } : {}) },
        repository(GOLDEN_REPOSITORY),
        GOLDEN_MARKER,
        ['AGENTS.md'],
      );

      expect(claude.text).toBe(golden('claude-instructions'));
      expect(codexPrompt(codex.text, 'Add a health check')).toBe(golden('codex-prompt'));
      expect(claude.notices).toEqual([]);
    }
  });

  it('gets, for an agent with instructions, the file and prompt it had before skills existed', async () => {
    for (const skills of [undefined, []]) {
      const run = reviewer(skills ? { skills } : {});
      const claude = await buildInstructions(run, repository(GOLDEN_REPOSITORY), GOLDEN_MARKER);
      const codex = await buildInstructions(run, repository(GOLDEN_REPOSITORY), GOLDEN_MARKER, [
        'AGENTS.md',
      ]);

      expect(claude.text).toBe(goldenAgent('claude-instructions'));
      expect(codexPrompt(codex.text, 'Add a health check')).toBe(goldenAgent('codex-prompt'));
    }
  });
});

describe('a Run with skills', () => {
  it('gets the section after the agent instructions in the Claude Code file, byte for byte', async () => {
    const built = await buildInstructions(
      reviewer({ skills: TWO }),
      repository(GOLDEN_REPOSITORY),
      GOLDEN_MARKER,
    );

    expect(built.text).toBe(goldenAgent('skills-claude-instructions'));
    expect(built.notices).toEqual([]);
  });

  it('gets the same section in the Codex prompt, byte for byte', async () => {
    const built = await buildInstructions(
      reviewer({ skills: TWO }),
      repository(GOLDEN_REPOSITORY),
      GOLDEN_MARKER,
      ['AGENTS.md'],
    );

    expect(codexPrompt(built.text, 'Add a health check')).toBe(goldenAgent('skills-codex-prompt'));
  });

  it('keeps the base rules first and unchanged, and lists name, description and absolute path of each skill', async () => {
    const built = await buildInstructions(reviewer({ skills: TWO }), repository({}), GOLDEN_MARKER);

    expect(built.text.startsWith(BASE_RULES.text.trimEnd() + '\n')).toBe(true);
    const section = built.text.slice(built.text.indexOf('\n## Skills\n'));
    expect(section).toContain('- lint: Lints the code and reports the findings.\n');
    expect(section).toContain(`  Entry file: ${RUN_DIR}/skills/lint/SKILL.md\n`);
    expect(section).toContain(`  Entry file: ${RUN_DIR}/skills/release-notes/SKILL.md\n`);
    expect(section).toMatch(/read its entry file and follow it/);
    // After the agent's own section, which it follows directly.
    expect(built.text.indexOf('\n## Agent instructions\n')).toBeLessThan(
      built.text.indexOf('\n## Skills\n'),
    );
    expect(built.text.endsWith(section)).toBe(true);
  });

  it('lists the skills of an agent that has no instructions, after the base rules alone', async () => {
    const built = await buildInstructions(
      { ...agentFields(), skills: TWO },
      repository({}),
      GOLDEN_MARKER,
    );

    expect(built.text.startsWith(BASE_RULES.text.trimEnd() + '\n\n## Skills\n')).toBe(true);
  });

  it('puts the repository text after the section, in the same blocks as before', async () => {
    const built = await buildInstructions(
      reviewer({ skills: TWO }),
      repository(GOLDEN_REPOSITORY),
      GOLDEN_MARKER,
    );

    expect(built.text.indexOf('\n## Skills\n')).toBeLessThan(
      built.text.indexOf('# Project conventions (from the repository, untrusted)'),
    );
  });

  it('refuses a location that is not one plain absolute path', async () => {
    for (const entryFile of ['skills/lint/SKILL.md', '/a\n/b/SKILL.md']) {
      await expect(
        buildInstructions(
          reviewer({ skills: [{ ...entry('lint'), entryFile }] }),
          repository({}),
          GOLDEN_MARKER,
        ),
      ).rejects.toThrow(TypeError);
    }
  });

  it('keeps the section when the agent instructions are cut to the total limit', async () => {
    const huge = {
      ...reviewer().agent,
      instructions: 'z'.repeat(INSTRUCTIONS_TOTAL_MAX_BYTES * 2),
    };

    const built = await buildInstructions(
      reviewer({ agent: huge, skills: TWO }),
      repository({ 'CLAUDE.md': 'Use pnpm.' }),
      GOLDEN_MARKER,
    );

    expect(bytes(built.text)).toBeLessThanOrEqual(INSTRUCTIONS_TOTAL_MAX_BYTES);
    expect(built.text.startsWith(BASE_RULES.text.trimEnd() + '\n')).toBe(true);
    expect(built.text).toContain('- lint: Lints the code and reports the findings.');
    expect(built.notices).toContain(
      "The agent's instructions were cut at 128 KiB in total; the rest was not given to the agent.",
    );
  });
});

describe('the size of the section', () => {
  it('is at most 8 KiB', () => {
    expect(SKILLS_SECTION_MAX_BYTES).toBe(8 * 1024);
  });

  it('leaves a section that fits untouched, with no notice', () => {
    const notices: string[] = [];

    const section = skillsSection(TWO, notices);

    expect(notices).toEqual([]);
    expect(bytes(section)).toBeLessThan(SKILLS_SECTION_MAX_BYTES);
  });

  it('shortens the descriptions to fit, never a name or a path, and says so', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      entry(`skill-${String(i).padStart(2, '0')}`, `Description ${i} `.repeat(70)),
    );
    const notices: string[] = [];

    const section = skillsSection(many, notices);

    expect(bytes(section)).toBeLessThanOrEqual(SKILLS_SECTION_MAX_BYTES);
    for (const skill of many) {
      expect(section).toContain(`- ${skill.name}`);
      expect(section).toContain(`  Entry file: ${skill.entryFile}\n`);
    }
    expect(section).toContain('...\n');
    expect(notices).toEqual([
      'The skills section was limited to 8 KiB: the descriptions of 20 skill(s) were shortened.',
    ]);
  });

  it('keeps a short description whole while the long ones give way', () => {
    const skills = [
      entry('short', 'Short and complete.'),
      entry('long-a', 'a'.repeat(1024)),
      entry('long-b', 'b'.repeat(1024)),
      entry('long-c', 'c'.repeat(1024)),
      entry('long-d', 'd'.repeat(1024)),
      entry('long-e', 'e'.repeat(1024)),
      entry('long-f', 'f'.repeat(1024)),
      entry('long-g', 'g'.repeat(1024)),
      entry('long-h', 'h'.repeat(1024)),
    ];
    const notices: string[] = [];

    const section = skillsSection(skills, notices);

    expect(bytes(section)).toBeLessThanOrEqual(SKILLS_SECTION_MAX_BYTES);
    expect(section).toContain('- short: Short and complete.\n');
    expect(notices).toEqual([
      'The skills section was limited to 8 KiB: the descriptions of 8 skill(s) were shortened.',
    ]);
  });

  it('cuts at a character boundary: no broken character is ever listed', () => {
    const skills = Array.from({ length: 12 }, (_, i) => entry(`s${i}`, 'é日本語 '.repeat(200)));

    const section = skillsSection(skills, []);

    expect(bytes(section)).toBeLessThanOrEqual(SKILLS_SECTION_MAX_BYTES);
    expect(section).not.toContain('�');
  });

  it('leaves skills out of the section, with a notice, only when names and paths alone do not fit', () => {
    const deep = `/${'d'.repeat(900)}`;
    const skills = Array.from({ length: 20 }, (_, i) => ({
      name: `skill-${i}`,
      description: 'Does it.',
      entryFile: `${deep}/skill-${i}/SKILL.md`,
    }));
    const notices: string[] = [];

    const section = skillsSection(skills, notices);

    expect(bytes(section)).toBeLessThanOrEqual(SKILLS_SECTION_MAX_BYTES);
    const listed = skills.filter((skill) => section.includes(`- ${skill.name}`)).length;
    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(20);
    expect(notices[0]).toBe(
      `The skills section was limited to 8 KiB: ${20 - listed} skill(s) are not listed in it, though their files are in place.`,
    );
  });

  it('turns a description with a line break into one line', () => {
    const section = skillsSection([entry('lint', 'First line\nSecond line')], []);

    expect(section).toContain('- lint: First line Second line\n');
  });
});
