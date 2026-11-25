import {
  AGENT_ENTRY_FILE,
  AGENTS_DIRECTORY,
  findAgentFolders,
  MAX_FILE_BYTES,
  validateAgentFolder,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import { DEFINITIONS_FILES, type DefinitionsFiles } from '../../../../projects/contracts/index.js';
import type { AgentFolderRead } from '../../../contracts/index.js';

export interface ReadAgentFolderInput {
  name: string;
  commit: string;
}

export type ReadAgentFolderResult = AgentFolderRead;

const UNAVAILABLE: ReadAgentFolderResult = { status: 'unavailable' };

/**
 * Only a commit or Clone that is really gone is `unavailable`; a Git failure or a platform that
 * cannot read says nothing about the commit, so it is `unreadable` and can be tried again.
 */
function unreadable(
  status: 'repository_not_ready' | 'commit_missing' | 'unsupported_platform' | 'failed',
): ReadAgentFolderResult {
  return status === 'commit_missing' || status === 'repository_not_ready'
    ? UNAVAILABLE
    : { status: 'unreadable', reason: 'read_failed' };
}

/**
 * The files of one agent's folder at a commit of the definitions Repository, judged by the shared
 * validation again (the commit is the Run's recorded one, but nothing here trusts that), without
 * the entry file: its instructions already travel with the Run.
 */
@Injectable()
export class ReadAgentFolderHandler {
  constructor(@Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles) {}

  async execute(input: ReadAgentFolderInput): Promise<ReadAgentFolderResult> {
    const { name, commit } = input;
    const tree = await this.definitions.listTree(commit);
    if (tree.status !== 'listed') return unreadable(tree.status);
    let folders = findAgentFolders(tree.entries);
    // A cut listing ends inside its last folder: that one may be partial, so it is not judged.
    if (tree.truncated) folders = folders.slice(0, -1);
    const folder = folders.find((candidate) => candidate.name === name);
    if (!folder) return tree.truncated ? { status: 'unreadable', reason: 'tree_cut' } : UNAVAILABLE;

    const prefix = `${AGENTS_DIRECTORY}/${name}/`;
    const executable = new Set(
      tree.entries
        .filter((item) => item.executable && item.path.startsWith(prefix))
        .map((item) => item.path.slice(prefix.length)),
    );
    const entryPath = `${prefix}${AGENT_ENTRY_FILE}`;
    const hasEntry = folder.entries.some(
      (item) => item.path === AGENT_ENTRY_FILE && item.kind === 'file',
    );
    let entryText: string | undefined;
    if (hasEntry) {
      const read = await this.definitions.readFiles(commit, [entryPath], MAX_FILE_BYTES);
      if (read.status !== 'read') return unreadable(read.status);
      const found = read.files[0];
      if (found?.status === 'found') entryText = found.text;
    }
    const judged = validateAgentFolder(
      name,
      folder.entries.map((item) =>
        item.path === AGENT_ENTRY_FILE && entryText !== undefined
          ? { ...item, content: entryText }
          : item,
      ),
    );
    if (!judged.ok) return { status: 'invalid', problems: judged.problems };

    const paths = judged.definition.files
      .map((file) => file.path)
      .filter((path) => path !== AGENT_ENTRY_FILE)
      .sort();
    if (paths.length === 0) return { status: 'found', files: [] };
    const blobs = await this.definitions.readBlobs(
      commit,
      paths.map((path) => `${prefix}${path}`),
      MAX_FILE_BYTES,
    );
    if (blobs.status !== 'read') return unreadable(blobs.status);
    if (blobs.files.length !== paths.length) return UNAVAILABLE;
    const files: { path: string; executable: boolean; content: Uint8Array }[] = [];
    for (const [index, path] of paths.entries()) {
      const blob = blobs.files[index];
      if (blob?.status !== 'found') return UNAVAILABLE;
      files.push({ path, executable: executable.has(path), content: blob.bytes });
    }
    return { status: 'found', files };
  }
}
