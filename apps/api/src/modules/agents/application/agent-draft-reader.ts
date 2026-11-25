import {
  AGENT_ENTRY_FILE,
  AGENTS_DIRECTORY,
  findAgentFolders,
  MAX_FILE_BYTES,
  type AgentEntry,
  type ProblemCode,
  validateAgentFolder,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import { DEFINITIONS_FILES, type DefinitionsFiles } from '../../projects/contracts/index.js';
import type { AgentDraft } from '../domain/entities/agent-draft.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../domain/repositories/agent-draft-repository.js';
import type { AgentDraftChange } from '../domain/value-objects/agent-draft-file.js';

export interface AgentDraftProblem {
  /** The agent folder the problem is in. */
  agent: string;
  code: ProblemCode;
  /** The file or folder in the Repository, with `/` separators. */
  path: string;
  key: string | null;
  message: string;
}

/** The Draft as the operator sees it: its changes, the problems they would make, and what moved upstream. */
export interface AgentDraftView {
  baseCommit: string | null;
  /** The commit the Repository holds now; `null` when none. */
  currentCommit: string | null;
  version: number;
  files: { path: string; change: AgentDraftChange; size: number; movedFrom: string | null }[];
  problems: AgentDraftProblem[];
  /** Paths of the Draft whose content differs between the base commit and the current one. */
  movedUpstream: string[];
}

/** How often a write retries its whole load, change and save when another write got in first. */
export const DRAFT_WRITE_ATTEMPTS = 3;

// A BOM is kept, as Git's own text read keeps it.
const LENIENT_UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

const entryPathOf = (agent: string) => `${AGENTS_DIRECTORY}/${agent}/${AGENT_ENTRY_FILE}`;

/**
 * Shows the Draft whole: judges each agent folder it touches with the Draft laid over the base
 * tree, and lists its paths that changed upstream by blob id. When the Clone cannot be read,
 * `problems` and `movedUpstream` are empty and the Draft itself is still shown.
 */
@Injectable()
export class AgentDraftReader {
  constructor(
    @Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles,
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
  ) {}

  async read(draft: AgentDraft): Promise<AgentDraftView> {
    const currentCommit = (await this.definitions.snapshot())?.commit ?? null;
    const baseCommit = draft.baseCommit;
    const files = draft.files.map(({ path, change, size, movedFrom }) => ({
      path,
      change,
      size,
      movedFrom,
    }));
    const view = {
      baseCommit,
      currentCommit,
      version: draft.version,
      files,
      problems: [] as AgentDraftProblem[],
      movedUpstream: [] as string[],
    };
    if (baseCommit === null || files.length === 0) return view;
    const [problems, movedUpstream] = await Promise.all([
      this.problemsOf(draft, baseCommit),
      this.movedUpstream(draft, baseCommit, currentCommit),
    ]);
    return { ...view, problems, movedUpstream };
  }

  private async problemsOf(draft: AgentDraft, baseCommit: string): Promise<AgentDraftProblem[]> {
    const tree = await this.definitions.listTree(baseCommit, { whole: true });
    if (tree.status !== 'listed' || tree.truncated) return [];

    const changed = new Map(draft.files.map((file) => [file.path, file]));
    const entries: AgentEntry[] = [
      ...tree.entries
        .filter((entry) => !changed.has(entry.path))
        .map(({ path, kind, size }) => ({ path, kind, size })),
      ...draft.files
        .filter((file) => !file.isDeleted)
        .map((file) => ({ path: file.path, kind: 'file', size: file.size })),
    ];
    const touched = new Set(
      draft.files.flatMap((file) => {
        const [top, name] = file.path.split('/');
        return top === AGENTS_DIRECTORY && name ? [name] : [];
      }),
    );
    const folders = findAgentFolders(entries)
      .filter((folder) => touched.has(folder.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const withEntry = folders.filter((folder) =>
      folder.entries.some((entry) => entry.path === AGENT_ENTRY_FILE && entry.kind === 'file'),
    );
    const drafted = withEntry.filter((folder) => !!changed.get(entryPathOf(folder.name)));
    const stored = await this.drafts.findContents(
      drafted.map((folder) => entryPathOf(folder.name)),
    );
    const unchanged = withEntry.filter((folder) => !changed.has(entryPathOf(folder.name)));
    const texts = new Map<string, string>();
    for (const [path, bytes] of stored) texts.set(path, LENIENT_UTF8.decode(bytes));
    if (unchanged.length > 0) {
      const read = await this.definitions.readFiles(
        baseCommit,
        unchanged.map((folder) => entryPathOf(folder.name)),
        MAX_FILE_BYTES,
      );
      if (read.status !== 'read') return [];
      for (const file of read.files) {
        if (file.status === 'found' && !file.binary) texts.set(file.path, file.text);
      }
    }

    return folders.flatMap((folder) => {
      const text = texts.get(entryPathOf(folder.name));
      const judged = validateAgentFolder(
        folder.name,
        folder.entries.map((entry) =>
          entry.path === AGENT_ENTRY_FILE && text !== undefined
            ? { ...entry, content: text }
            : entry,
        ),
      );
      if (judged.ok) return [];
      return judged.problems.map((problem): AgentDraftProblem => ({
        agent: folder.name,
        code: problem.code,
        path:
          problem.path === ''
            ? `${AGENTS_DIRECTORY}/${folder.name}`
            : `${AGENTS_DIRECTORY}/${folder.name}/${problem.path}`,
        key: problem.key ?? null,
        message: problem.message,
      }));
    });
  }

  private async movedUpstream(
    draft: AgentDraft,
    baseCommit: string,
    currentCommit: string | null,
  ): Promise<string[]> {
    if (currentCommit === null || currentCommit === baseCommit) return [];
    const paths = draft.files.map((file) => file.path);
    const [atBase, atCurrent] = await Promise.all([
      this.definitions.blobIds(baseCommit, paths),
      this.definitions.blobIds(currentCommit, paths),
    ]);
    if (atBase.status !== 'read' || atCurrent.status !== 'read') return [];
    // Equal content with another Git mode (the executable bit) is a change too.
    const current = new Map(atCurrent.blobs.map((entry) => [entry.path, entry]));
    return atBase.blobs
      .filter((entry) => {
        const now = current.get(entry.path);
        return (
          (now?.blob ?? null) !== entry.blob || (now?.executable ?? false) !== entry.executable
        );
      })
      .map((entry) => entry.path)
      .sort();
  }
}
