import { vi } from 'vitest';
import type { DefinitionAgentStanding } from '../../../agents/contracts/index.js';
import type { ProviderAvailabilityView } from '../../../executions/contracts/index.js';
import type {
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsSnapshot,
  DefinitionsTreeEntry,
  DefinitionsTreeResult,
} from '../../../projects/contracts/index.js';
import { DefinitionsWorkflowPlans } from '../../entry-points/contracts/workflow-plans.js';
import { WorkflowDefinitions } from '../workflow-definitions.js';
import { WorkflowsReader } from '../workflows-reader.js';

export const COMMIT = 'a'.repeat(40);

export const phase = (id: string, kind: 'work' | 'review', agent: string) =>
  `  - id: ${id}\n    kind: ${kind}\n    agent: ${agent}`;

export const checkpoint = (id: string, text: string) =>
  `  - id: ${id}\n    kind: checkpoint\n    text: ${text}`;

export const workflowText = (
  name: string,
  items: string[] = [phase('build', 'work', 'builder')],
  head = '',
) =>
  `---\nname: ${name}\ndescription: Does ${name}\n${head}sequence:\n${items.join('\n')}\n---\nNotes.\n`;

export const file = (path: string, size = 10): DefinitionsTreeEntry => ({
  path,
  kind: 'file',
  size,
  executable: false,
});

export const listed = (...entries: DefinitionsTreeEntry[]): DefinitionsTreeResult => ({
  status: 'listed',
  entries,
  truncated: false,
});

export interface Script {
  snapshot?: DefinitionsSnapshot | null;
  tree?: DefinitionsTreeResult;
  files?: Record<string, string>;
  readFiles?: DefinitionsFilesResult;
  agents?: Record<string, DefinitionAgentStanding>;
  settled?: boolean;
  providers?: ProviderAvailabilityView[];
}

const BOTH_AVAILABLE: ProviderAvailabilityView[] = [
  { id: 'claude_code', name: 'Claude Code', available: true },
  { id: 'codex', name: 'Codex', available: true },
];

export const OK_AGENTS: Record<string, DefinitionAgentStanding> = {
  builder: { valid: true, provider: 'claude_code' },
  reviewer: { valid: true, provider: 'codex' },
};

/** A scripted definitions Repository, agent face and Provider list: no Git, no workers. */
export function scripted(script: Script) {
  const files = script.files ?? {};
  const definitions = {
    snapshot: vi.fn(() =>
      Promise.resolve(
        script.snapshot === undefined
          ? { state: 'ready' as const, commit: COMMIT }
          : script.snapshot,
      ),
    ),
    listTree: vi.fn((): Promise<DefinitionsTreeResult> => Promise.resolve(script.tree ?? listed())),
    readFiles: vi.fn((_commit: string, paths: readonly string[]): Promise<DefinitionsFilesResult> =>
      Promise.resolve(
        script.readFiles ?? {
          status: 'read',
          files: paths.map((path) =>
            path in files
              ? {
                  path,
                  status: 'found' as const,
                  text: files[path]!,
                  size: files[path]!.length,
                  binary: false,
                }
              : { path, status: 'missing' as const, size: 0 as const },
          ),
        },
      ),
    ),
    readBlobs: vi.fn(() => Promise.reject(new Error('not used'))),
    blobIds: vi.fn(() => Promise.reject(new Error('not used'))),
  } satisfies DefinitionsFiles;
  const standings = {
    at: vi.fn((_commit: string, names: readonly string[]) =>
      Promise.resolve({
        standings: new Map(
          [...new Set(names)].flatMap((name): [string, DefinitionAgentStanding][] => {
            const standing = script.agents?.[name];
            return standing ? [[name, standing]] : [];
          }),
        ),
        settled: script.settled ?? true,
      }),
    ),
  };
  const providers = { list: vi.fn(() => Promise.resolve(script.providers ?? BOTH_AVAILABLE)) };
  return {
    definitions,
    standings,
    providers,
    reader: new WorkflowsReader(new WorkflowDefinitions(definitions, standings), providers),
    plans: new DefinitionsWorkflowPlans(new WorkflowDefinitions(definitions, standings)),
  };
}
