import {
  AGENT_ENTRY_FILE,
  AGENT_NAME_PATTERN,
  agentSkillNames,
  checkAgentSkills,
  MARKDOWN_FILE,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FOLDER_BYTES,
  SKILL_ENTRY_FILE,
  validateSkillFolder,
  type AgentEntry,
} from '@agentic-studio/agent-definitions';
import type {
  AgentDraftSkillProblemOutput,
  AgentSummaryOutput,
  SkillSummaryOutput,
} from '../../../../platform/api';
import {
  placedKey,
  type EditorEntry,
  type ListedProblem,
  type ProblemTarget,
} from './editor-model';

const SKILL_PATH = /^skills\/([^/]+)\//;

/** The folder of the skill that holds `path`, or null for a file elsewhere. */
export function skillOfPath(path: string): string | null {
  return SKILL_PATH.exec(path)?.[1] ?? null;
}

/** The text of a new skill's entry file: it passes the validation for a plain name. */
export function newSkillFile(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: Describe what this skill is for.',
    '---',
    '',
    'Write the steps of this skill here.',
    '',
  ].join('\n');
}

/** Why a name cannot be a new skill's, or undefined when it can. */
export function skillNameError(name: string, taken: ReadonlySet<string>): string | undefined {
  if (name === '') return 'Enter a name for the skill.';
  if (!AGENT_NAME_PATTERN.test(name)) {
    return 'Use 1 to 64 characters: lower-case letters, digits and "-", starting with a letter or digit.';
  }
  if (taken.has(name)) return 'A skill folder with this name already exists.';
  return undefined;
}

/** Why the Draft was not judged, in words for the operator; Publish stays off. */
export const NOT_JUDGED_TEXT = {
  clone_unreadable:
    'The Draft could not be checked now: the files of the Repository cannot be read. Try again in a moment; Publish stays off until it can be checked.',
  over_limits:
    'The Draft touches more skills and agents than one check can read, so it cannot be published. Split the changes into smaller Drafts.',
} as const;

const skillTarget = (
  skill: string,
  problem: { code: string; path: string; key?: string | null },
): ProblemTarget => {
  const path = `skills/${skill}/${problem.path === '' ? SKILL_ENTRY_FILE : problem.path}`;
  const key = placedKey(problem.code, problem.key);
  return key ? { path, key } : { path };
};

/** A skill problem as listed: from the API's skill list (paths relative to the folder). */
export function fromBaseSkill(skill: SkillSummaryOutput): ListedProblem[] {
  return skill.problems.map((problem) => ({
    agent: null,
    skill: skill.name,
    code: problem.code,
    message: problem.message,
    target: skillTarget(skill.name, problem),
  }));
}

/** A skill problem as listed: from the Draft answer (paths from the Repository root). */
export function fromDraftSkill(problem: AgentDraftSkillProblemOutput): ListedProblem {
  const target: ProblemTarget = { path: problem.path };
  const key = placedKey(problem.code, problem.key);
  if (key) target.key = key;
  return {
    agent: null,
    skill: problem.skill,
    code: problem.code,
    message: problem.message,
    target,
  };
}

const filesOf = (folder: readonly AgentEntry[]) => folder.filter((item) => item.kind === 'file');

/** A folder the validation refuses by the declared count and sizes alone, as the API's reader sees it. */
function refusedBySize(folder: readonly AgentEntry[]): boolean {
  const files = filesOf(folder);
  return (
    files.length > MAX_FILES ||
    files.some((item) => item.size > MAX_FILE_BYTES) ||
    files.reduce((sum, item) => sum + item.size, 0) > MAX_FOLDER_BYTES
  );
}

/**
 * The problems of skill folder `skill` as the API judges it: the entry file and Markdown files
 * are read (none for a folder its sizes refuse, which drops its "cannot be read" reasons), and a
 * Markdown file whose text is not in `texts` gets none. Undefined while the entry text is unknown.
 */
export function validateSkillLive(
  skill: string,
  entries: readonly EditorEntry[],
  texts: ReadonlyMap<string, string>,
  sizes: ReadonlyMap<string, number>,
): ListedProblem[] | undefined {
  const prefix = `skills/${skill}/`;
  const folder: AgentEntry[] = [];
  for (const item of entries) {
    if (!item.path.startsWith(prefix) || item.change === 'deleted') continue;
    folder.push({
      path: item.path.slice(prefix.length),
      kind: item.kind,
      size: sizes.get(item.path) ?? item.size,
    });
  }
  const refused = refusedBySize(folder);
  const entryExists = folder.some((item) => item.path === SKILL_ENTRY_FILE);
  if (entryExists && !refused && texts.get(`${prefix}${SKILL_ENTRY_FILE}`) === undefined) {
    return undefined;
  }
  const unknown = new Set<string>();
  const given = folder.map((item) => {
    const wanted = item.path === SKILL_ENTRY_FILE || MARKDOWN_FILE.test(item.path);
    const text = texts.get(`${prefix}${item.path}`);
    if (!wanted || refused || item.kind !== 'file') return item;
    if (text === undefined) {
      unknown.add(item.path);
      return item;
    }
    return { ...item, content: text };
  });
  const result = validateSkillFolder(skill, given);
  if (result.ok) return [];
  return result.problems
    .filter(
      (problem) => problem.code !== 'entry_unreadable' || (!refused && !unknown.has(problem.path)),
    )
    .map((problem) => ({
      agent: null,
      skill,
      code: problem.code,
      message: problem.message,
      target: skillTarget(skill, problem),
    }));
}

/** Whether each skill folder of the Draft's state is valid: absent means it does not exist. */
export function skillStandings(
  entries: readonly EditorEntry[],
  base: readonly SkillSummaryOutput[],
  withProblems: ReadonlySet<string>,
  touched: ReadonlySet<string>,
): Map<string, { valid: boolean }> {
  const baseValid = new Map(base.map((skill) => [skill.name, skill.valid]));
  const standings = new Map<string, { valid: boolean }>();
  for (const item of entries) {
    if (item.skill === null || item.change === 'deleted' || standings.has(item.skill)) continue;
    const valid = touched.has(item.skill)
      ? !withProblems.has(item.skill)
      : (baseValid.get(item.skill) ?? false);
    standings.set(item.skill, { valid });
  }
  return standings;
}

const SKILL_CHECK_CODES = new Set(['skill_missing', 'skill_invalid']);

const agentEntryTarget = (agent: string, code: string): ProblemTarget => ({
  path: `agents/${agent}/${AGENT_ENTRY_FILE}`,
  key: placedKey(code, null) ?? 'skills',
});

/** Problems of an agent's skill check, from the names it lists. */
export function skillCheckProblems(
  agent: string,
  names: readonly string[],
  standings: ReadonlyMap<string, { valid: boolean }>,
  note?: string,
): ListedProblem[] {
  return checkAgentSkills({ skills: [...names] }, standings).map((problem) => ({
    agent,
    skill: null,
    code: problem.code,
    message: problem.message,
    target: agentEntryTarget(agent, problem.code),
    ...(note ? { note } : {}),
  }));
}

/** The note shown beside a problem of an agent the Draft does not change. */
export const NAMES_TOUCHED_SKILL =
  'This agent is not changed, but it names a skill the Draft changes.';

/**
 * The agents that name `skill` as the Draft leaves them: the base agents' listed names, and for an
 * agent whose entry file the Draft writes, the names in `draftTexts` (by entry path).
 */
export function agentsNaming(
  skill: string,
  baseAgents: readonly AgentSummaryOutput[],
  entries: readonly EditorEntry[],
  draftTexts: ReadonlyMap<string, string>,
): string[] {
  const written = new Set(
    entries
      .filter((item) => item.change === 'added' || item.change === 'modified')
      .map((item) => item.path),
  );
  const names = new Set<string>();
  for (const agent of baseAgents) {
    if (agent.source !== 'definitions') continue;
    const path = `agents/${agent.name}/${AGENT_ENTRY_FILE}`;
    if (written.has(path)) continue;
    if (agent.skills.includes(skill)) names.add(agent.name);
  }
  for (const item of entries) {
    const agent = /^agents\/([^/]+)\/AGENT\.md$/.exec(item.path)?.[1];
    if (!agent || !written.has(item.path)) continue;
    const text = draftTexts.get(item.path);
    if (text !== undefined && agentSkillNames(text).includes(skill)) names.add(agent);
  }
  return [...names].sort();
}

/**
 * The problems of the agents the Draft does not change that name `skill`, with the skill as the
 * browser sees it now: their own problems other than the skill check, then the skill check.
 */
export function namingAgentProblems(
  skill: string,
  baseAgents: readonly AgentSummaryOutput[],
  changedAgents: ReadonlySet<string>,
  standings: ReadonlyMap<string, { valid: boolean }>,
): Map<string, ListedProblem[]> {
  const result = new Map<string, ListedProblem[]>();
  for (const agent of baseAgents) {
    if (agent.source !== 'definitions' || changedAgents.has(agent.name)) continue;
    if (!agent.skills.includes(skill)) continue;
    const own = agent.problems
      .filter((problem) => !SKILL_CHECK_CODES.has(problem.code))
      .map((problem): ListedProblem => ({
        agent: agent.name,
        skill: null,
        code: problem.code,
        message: problem.message,
        target: {
          path: `agents/${agent.name}/${problem.path === '' ? AGENT_ENTRY_FILE : problem.path}`,
          ...(placedKey(problem.code, problem.key)
            ? { key: placedKey(problem.code, problem.key)! }
            : {}),
        },
        note: NAMES_TOUCHED_SKILL,
      }));
    result.set(agent.name, [
      ...own,
      ...skillCheckProblems(agent.name, agent.skills, standings, NAMES_TOUCHED_SKILL),
    ]);
  }
  return result;
}
