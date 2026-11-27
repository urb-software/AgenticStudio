import { AGENTS_DIRECTORY, SKILLS_DIRECTORY, WORKFLOWS_DIRECTORY } from './limits.js';
import type { AgentEntry } from './validate.js';

export interface AgentFolder {
  /** The folder's name, which is the agent's name. */
  name: string;
  /** The folder's entries, with paths relative to it. */
  entries: AgentEntry[];
}

export interface SkillFolder {
  /** The folder's name, which is the skill's name. */
  name: string;
  /** The folder's entries, with paths relative to it. */
  entries: AgentEntry[];
}

function groupFolders(
  directory: string,
  repositoryEntries: readonly AgentEntry[],
): { name: string; entries: AgentEntry[] }[] {
  const prefix = `${directory}/`;
  const folders = new Map<string, AgentEntry[]>();
  for (const entry of repositoryEntries) {
    if (!entry.path.startsWith(prefix)) continue;
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name === '') continue;
    const inside = slash === -1 ? '' : rest.slice(slash + 1);
    if (inside === '') {
      // The folder itself: a directory is only its anchor, a plain file is not a folder at all.
      if (entry.kind === 'directory') {
        if (!folders.has(name)) folders.set(name, []);
      } else if (entry.kind !== 'file') {
        folders.set(name, [...(folders.get(name) ?? []), { ...entry, path: '' }]);
      }
      continue;
    }
    folders.set(name, [...(folders.get(name) ?? []), { ...entry, path: inside }]);
  }
  return [...folders].map(([name, entries]) => ({ name, entries }));
}

/**
 * Groups a Repository tree into agent folders (`agents/<name>/...`); `skills/` and the rest are
 * ignored. A name that is itself a symbolic link stays as a folder holding that one entry, so
 * the validation refuses it. Pure.
 */
export function findAgentFolders(repositoryEntries: readonly AgentEntry[]): AgentFolder[] {
  return groupFolders(AGENTS_DIRECTORY, repositoryEntries);
}

/** The same for skill folders (`skills/<name>/...`); `agents/` and the rest are ignored. Pure. */
export function findSkillFolders(repositoryEntries: readonly AgentEntry[]): SkillFolder[] {
  return groupFolders(SKILLS_DIRECTORY, repositoryEntries);
}

export interface WorkflowFolder {
  /** The folder's name, which is the workflow's name. */
  name: string;
  /** The folder's entries, with paths relative to it. */
  entries: AgentEntry[];
}

/** The same for workflow folders (`workflows/<name>/...`); the other folders are ignored. Pure. */
export function findWorkflowFolders(repositoryEntries: readonly AgentEntry[]): WorkflowFolder[] {
  return groupFolders(WORKFLOWS_DIRECTORY, repositoryEntries);
}
