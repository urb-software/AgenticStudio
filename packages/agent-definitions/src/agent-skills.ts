import { parseEntry } from './front-matter.js';
import { AGENT_ENTRY_FILE } from './limits.js';
import { problem, type Problem } from './problems.js';
import type { AgentDefinition } from './validate.js';

/** What the check needs to know of a skill that exists at the agent's commit. */
export interface SkillStanding {
  valid: boolean;
}

/**
 * Judges the skills an agent names against the skills that exist at the same commit: a skill that
 * is absent from the map does not exist; one with `valid: false` (or one that could not be
 * judged) is invalid. Names are compared exactly. Pure: the caller reads the skills.
 */
export function checkAgentSkills(
  agent: Pick<AgentDefinition, 'skills'>,
  skills: ReadonlyMap<string, SkillStanding>,
): Problem[] {
  const problems: Problem[] = [];
  for (const name of agent.skills) {
    const standing = skills.get(name);
    if (standing === undefined) problems.push(problem('skill_missing', AGENT_ENTRY_FILE, name));
    else if (!standing.valid) problems.push(problem('skill_invalid', AGENT_ENTRY_FILE, name));
  }
  return problems;
}

/**
 * The skill names an entry file's front matter lists, whether or not the agent is otherwise
 * valid; empty when the front matter cannot be read or `skills` is not a list of text.
 */
export function agentSkillNames(entryText: string): string[] {
  const parsed = parseEntry(entryText);
  if (parsed.status !== 'ok') return [];
  const value = parsed.values['skills'];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return [];
  return value as string[];
}
