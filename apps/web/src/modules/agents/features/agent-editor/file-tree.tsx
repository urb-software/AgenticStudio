import { ChevronRightIcon, FileIcon, FolderIcon } from 'lucide-react';
import type { AgentSummaryOutput } from '../../../../platform/api';
import { CHANGE_LABEL, type TreeNode } from './editor-model';

const CHANGE_CLASS = {
  added: 'text-run-succeeded',
  modified: 'text-run-awaiting',
  deleted: 'text-run-failed',
} as const;

/** The validation state of an agent folder, as shown beside its name. */
export function agentState(agent: AgentSummaryOutput | undefined): string | undefined {
  if (!agent) return undefined;
  if (agent.usable) return 'Valid';
  const count = agent.problems.length;
  return count === 0 ? 'Not usable' : `${count} ${count === 1 ? 'problem' : 'problems'}`;
}

interface FileTreeProps {
  nodes: readonly TreeNode[];
  /** The open file's path. */
  selected: string | undefined;
  expanded: ReadonlySet<string>;
  /** The validation state of each agent folder by name, as shown beside it. */
  states: ReadonlyMap<string, string>;
  onToggle: (folder: string) => void;
  onOpen: (path: string) => void;
}

const ROW =
  'flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-code pointer-coarse:min-h-11';

/** The files of the Repository as nested lists; folders are disclosure buttons. */
export function FileTree({ nodes, selected, expanded, states, onToggle, onOpen }: FileTreeProps) {
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {nodes.map((node) => {
        if (node.kind === 'folder') {
          const open = expanded.has(node.path);
          const state = node.agent ? states.get(node.agent) : undefined;
          return (
            <li key={node.path}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => onToggle(node.path)}
                className={`${ROW} cursor-pointer text-text hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring`}
              >
                <ChevronRightIcon
                  aria-hidden="true"
                  className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                />
                <FolderIcon aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
                <span className="min-w-0 break-all">{node.name}</span>
                {state ? (
                  <span
                    className={`ml-auto shrink-0 text-caption font-medium whitespace-nowrap ${
                      state === 'Valid' ? 'text-run-succeeded' : 'text-run-failed'
                    }`}
                  >
                    {state}
                  </span>
                ) : null}
              </button>
              {open ? (
                <div className="ml-3 border-l border-border pl-1">
                  <FileTree
                    nodes={node.children}
                    selected={selected}
                    expanded={expanded}
                    states={states}
                    onToggle={onToggle}
                    onOpen={onOpen}
                  />
                </div>
              ) : null}
            </li>
          );
        }
        if (!node.entry.openable && node.entry.change !== 'deleted') {
          return (
            <li key={node.path}>
              <span className={`${ROW} text-text-dim`}>
                <FileIcon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 break-all">{node.name}</span>
                <span className="ml-auto shrink-0 text-caption whitespace-nowrap">
                  Not openable
                </span>
              </span>
            </li>
          );
        }
        const current = node.path === selected;
        return (
          <li key={node.path}>
            <button
              type="button"
              aria-current={current ? 'true' : undefined}
              onClick={() => onOpen(node.path)}
              className={`${ROW} cursor-pointer hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring ${
                current ? 'bg-brand-soft font-medium text-text' : 'text-text-muted'
              }`}
            >
              <FileIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span
                className={`min-w-0 break-all ${node.entry.change === 'deleted' ? 'line-through' : ''}`}
                title={node.entry.movedFrom ? `Moved from ${node.entry.movedFrom}` : undefined}
              >
                {node.name}
              </span>
              {node.entry.change ? (
                <span
                  className={`ml-auto shrink-0 text-caption font-medium whitespace-nowrap ${CHANGE_CLASS[node.entry.change]}`}
                >
                  {CHANGE_LABEL[node.entry.change]}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
