import { ApiError } from '../../../platform/api';

/** The request a list makes, with the status and title of a failed answer when there is one. */
export function readRequestOf(request: string, error: unknown): string {
  if (!(error instanceof ApiError) || error.status === 0) return request;
  const status = [error.status, error.problem?.title].filter(Boolean).join(' ');
  return `${request} · ${status}`;
}

/** The editor on one file of the definitions Repository. */
export function editorHref(path: string): string {
  return `/agents/editor?${new URLSearchParams({ path })}`;
}

/** The editor on the entry file of a Workflow. */
export function workflowEditorHref(name: string): string {
  return editorHref(`workflows/${name}/WORKFLOW.md`);
}

/** The Agents page with one definitions agent open. */
export function agentHref(name: string): string {
  return `/agents?${new URLSearchParams({ open: name })}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
