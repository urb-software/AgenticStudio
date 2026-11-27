import { vi } from 'vitest';
import type {
  ProblemDetails,
  WorkflowDetailOutput,
  WorkflowItemOutput,
  WorkflowListOutput,
  WorkflowSummaryOutput,
} from '../../../platform/api';

export const WORKFLOWS_COMMIT = '0123456789abcdef0123456789abcdef01234567';

export function workflowList(overrides: Partial<WorkflowListOutput> = {}): WorkflowListOutput {
  return {
    commit: WORKFLOWS_COMMIT,
    repository: { state: 'ready', note: null },
    truncated: false,
    workflows: [],
    ...overrides,
  };
}

export function summary(
  name: string,
  overrides: Partial<WorkflowSummaryOutput> = {},
): WorkflowSummaryOutput {
  return {
    name,
    description: `Does ${name}`,
    valid: true,
    usable: true,
    notUsableReason: null,
    problems: [],
    ...overrides,
  };
}

export const work = (
  id: string,
  agent: string,
  overrides: Partial<Extract<WorkflowItemOutput, { kind: 'work' }>> = {},
): WorkflowItemOutput => ({
  kind: 'work',
  id,
  agent,
  agentState: 'valid',
  provider: 'claude_code',
  usable: true,
  ...overrides,
});

export const review = (
  id: string,
  agent: string,
  overrides: Partial<Extract<WorkflowItemOutput, { kind: 'review' }>> = {},
): WorkflowItemOutput => ({
  kind: 'review',
  id,
  agent,
  agentState: 'valid',
  provider: 'codex',
  usable: true,
  ...overrides,
});

export const checkpoint = (id: string, text: string): WorkflowItemOutput => ({
  kind: 'checkpoint',
  id,
  text,
});

export function workflowDetail(
  workflow: WorkflowSummaryOutput,
  extras: { items?: WorkflowItemOutput[]; sendBacks?: number | null } = {},
): WorkflowDetailOutput {
  return {
    commit: WORKFLOWS_COMMIT,
    repository: { state: 'ready', note: null },
    ...workflow,
    sendBacks: extras.sendBacks === undefined ? 2 : extras.sendBacks,
    items: extras.items ?? [],
  };
}

function json(status: number, body: unknown): Response {
  const contentType = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

/** The workflows API behind `fetch`: the list, and each detail by name (404 for any other). */
export function fakeWorkflowsApi(
  initial: WorkflowListOutput,
  details: Record<string, WorkflowDetailOutput> = {},
) {
  let list = initial;
  const calls: string[] = [];
  const listFailures: { status: number; body: unknown }[] = [];
  const fetch = vi.fn((request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    calls.push(pathname);
    if (pathname === '/api/workflows') {
      const failure = listFailures.shift();
      return Promise.resolve(failure ? json(failure.status, failure.body) : json(200, list));
    }
    const match = /^\/api\/workflows\/([^/]+)$/.exec(pathname);
    const found = match ? details[decodeURIComponent(match[1] ?? '')] : undefined;
    return Promise.resolve(
      found
        ? json(200, found)
        : json(404, {
            type: 'urn:agentic-studio:problem:workflow-not-found',
            title: 'Workflow not found',
            status: 404,
            detail: 'No Workflow has this name.',
            correlationId: 'c-1',
          } satisfies ProblemDetails),
    );
  });
  vi.stubGlobal('fetch', fetch);
  return {
    calls,
    /** What the next reads of the list and of the Workflows answer. */
    serve(next: WorkflowListOutput, nextDetails: Record<string, WorkflowDetailOutput> = details) {
      list = next;
      Object.assign(details, nextDetails);
    },
    failNextList(status: number, body: unknown) {
      listFailures.push({ status, body });
    },
    count: (path: string) => calls.filter((call) => call === path).length,
  };
}
