import {
  MAX_FILE_BYTES,
  RUN_SKILLS_MAX_BYTES,
  SKILLS_DIRECTORY,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import {
  DEFINITIONS_FILES,
  type DefinitionsFiles,
  type DefinitionsUnavailable,
} from '../../../../projects/contracts/index.js';
import type { AgentFolderFile, RunSkillsFailure } from '../../../contracts/index.js';
import { type SkillView, SkillsReader } from '../../skills-reader.js';

const UNAVAILABLE: RunSkillsFailure = { status: 'unavailable' };
const UNREADABLE: RunSkillsFailure = { status: 'unreadable' };

/**
 * Only a commit or Clone that is really gone is `unavailable`; a Git failure or a platform that
 * cannot read says nothing about the commit, so it is `unreadable` and can be tried again.
 */
function unavailable(status: DefinitionsUnavailable): RunSkillsFailure {
  return status === 'commit_missing' || status === 'repository_not_ready'
    ? UNAVAILABLE
    : UNREADABLE;
}

export interface ReadRunSkillsInput {
  /** The Run's recorded skill names, in its order. */
  names: readonly string[];
  /** The Run's recorded commit. */
  commit: string;
  /** `descriptions` reads no file content; `files` reads the files, within the Run's byte budget. */
  include: 'descriptions' | 'files';
}

/**
 * `files` is empty for `descriptions`. For `files`, `omitted` names the skills left out because
 * those before them already used the Run's byte budget; they are not in `skills`.
 */
export type ReadRunSkillsResult =
  | {
      status: 'found';
      skills: { name: string; description: string; files: AgentFolderFile[] }[];
      omitted: string[];
    }
  | RunSkillsFailure;

type Judged = { status: 'found'; views: SkillView[] } | RunSkillsFailure;

/**
 * The skills a Run recorded, read at the commit it recorded and judged by the shared validation:
 * their descriptions for the claim and their files for the worker. The caller names the skills
 * and the commit from the Run's record; nothing here looks at the last fetched commit.
 */
@Injectable()
export class ReadRunSkillsHandler {
  constructor(
    private readonly skills: SkillsReader,
    @Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles,
  ) {}

  async execute(input: ReadRunSkillsInput): Promise<ReadRunSkillsResult> {
    const { names, commit } = input;
    const judged = await this.judge(names, commit);
    if (judged.status !== 'found') return judged;
    const describe = (view: SkillView) => ({
      name: view.name,
      description: view.description ?? '',
    });
    if (input.include === 'descriptions') {
      return {
        status: 'found',
        skills: judged.views.map((view) => ({ ...describe(view), files: [] })),
        omitted: [],
      };
    }
    if (judged.views.length === 0) return { status: 'found', skills: [], omitted: [] };

    // Skills are taken in the order named while their files stay within the Run's budget; the first
    // that does not fit and every skill after it are left out.
    const taken: SkillView[] = [];
    let total = 0;
    for (const view of judged.views) {
      const size = view.files.reduce((sum, item) => sum + item.size, 0);
      if (total + size > RUN_SKILLS_MAX_BYTES) break;
      total += size;
      taken.push(view);
    }
    const omitted = judged.views.slice(taken.length).map((view) => view.name);
    if (taken.length === 0) return { status: 'found', skills: [], omitted };

    const tree = await this.definitions.listTree(commit, { directory: SKILLS_DIRECTORY });
    if (tree.status !== 'listed') return unavailable(tree.status);
    const executable = new Set(
      tree.entries.filter((item) => item.executable).map((item) => item.path),
    );
    const listedPaths = new Set(tree.entries.map((item) => item.path));

    const skills: { name: string; description: string; files: AgentFolderFile[] }[] = [];
    for (const view of taken) {
      const prefix = `${SKILLS_DIRECTORY}/${view.name}/`;
      const paths = view.files.map((item) => item.path).sort();
      // A cut listing may lack the mode of a file: it is not guessed.
      if (tree.truncated && paths.some((path) => !listedPaths.has(`${prefix}${path}`))) {
        return UNREADABLE;
      }
      const blobs = await this.definitions.readBlobs(
        commit,
        paths.map((path) => `${prefix}${path}`),
        MAX_FILE_BYTES,
      );
      if (blobs.status !== 'read') return unavailable(blobs.status);
      if (blobs.files.length !== paths.length) return UNAVAILABLE;
      const files: AgentFolderFile[] = [];
      for (const [index, path] of paths.entries()) {
        const blob = blobs.files[index];
        if (blob?.status !== 'found') return UNAVAILABLE;
        files.push({
          path,
          executable: executable.has(`${prefix}${path}`),
          content: blob.bytes,
        });
      }
      skills.push({ ...describe(view), files });
    }
    return { status: 'found', skills, omitted };
  }

  /** Every named skill, as a valid view in the order named; anything else fails them all. */
  private async judge(names: readonly string[], commit: string): Promise<Judged> {
    const read = await this.skills.viewsAt(commit, names);
    if (read.status !== 'read') return unavailable(read.status);
    const views: SkillView[] = [];
    const problems: { skill: string; code: string; path: string }[] = [];
    for (const name of names) {
      const view = read.skills.get(name);
      if (!view) return UNAVAILABLE;
      if (!view.valid) {
        for (const problem of view.problems) {
          problems.push({ skill: name, code: problem.code, path: problem.path });
        }
        if (view.problems.length === 0) problems.push({ skill: name, code: 'unusable', path: '' });
      }
      views.push(view);
    }
    if (problems.length > 0) return { status: 'invalid', problems };
    return { status: 'found', views };
  }
}
