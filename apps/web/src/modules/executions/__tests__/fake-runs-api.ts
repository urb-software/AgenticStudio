import { vi } from 'vitest';
import type {
  PreparedFollowUpOutput,
  ReviewCommentsOutput,
  AgentWorkerOutput,
  MergeReviewFileOutput,
  MergeReviewOutput,
  ProblemDetails,
  ProjectOutput,
  ProviderAvailabilityOutput,
  RunDiffFileOutput,
  RunDiffOutput,
  RunEventOutput,
  RunOutput,
  RunStepOutput,
} from '../../../platform/api';

type Route =
  | 'projects'
  | 'project'
  | 'projectRuns'
  | 'start'
  | 'runs'
  | 'summary'
  | 'run'
  | 'retryDelivery'
  | 'resume'
  | 'providers'
  | 'agentWorker'
  | 'events'
  | 'steps'
  | 'stream'
  | 'cancel'
  | 'answer'
  | 'followUp'
  | 'bringUp'
  | 'refresh'
  | 'closePullRequest'
  | 'mergeRun'
  | 'prepare'
  | 'prepared'
  | 'discardPrepared'
  | 'loadComments'
  | 'comments'
  | 'diff'
  | 'diffFile'
  | 'mergeReview'
  | 'requestMergeReview'
  | 'mergeReviewFile';

interface ScriptedResponse {
  status: number;
  body: unknown;
}

const ROUTES: readonly [RegExp, (method: string) => Route][] = [
  [/^\/api\/projects()$/, () => 'projects'],
  [/^\/api\/projects\/([^/]+)$/, () => 'project'],
  [/^\/api\/projects\/([^/]+)\/runs$/, (method) => (method === 'POST' ? 'start' : 'projectRuns')],
  [/^\/api\/runs$/, () => 'runs'],
  [/^\/api\/runs\/(summary)$/, () => 'summary'],
  [/^\/api\/runs\/([^/]+)$/, () => 'run'],
  [/^\/api\/runs\/([^/]+)\/retry-delivery$/, () => 'retryDelivery'],
  [/^\/api\/runs\/([^/]+)\/resume$/, () => 'resume'],
  [/^\/api\/providers()$/, () => 'providers'],
  [/^\/api\/agent-worker()$/, () => 'agentWorker'],
  [/^\/api\/runs\/([^/]+)\/cancel$/, () => 'cancel'],
  [/^\/api\/runs\/([^/]+)\/answer$/, () => 'answer'],
  [/^\/api\/runs\/([^/]+)\/follow-up$/, () => 'followUp'],
  [/^\/api\/runs\/([^/]+)\/bring-up-to-date$/, () => 'bringUp'],
  [/^\/api\/runs\/([^/]+)\/pull-request\/refresh$/, () => 'refresh'],
  [/^\/api\/runs\/([^/]+)\/pull-request\/close$/, () => 'closePullRequest'],
  [/^\/api\/runs\/([^/]+)\/merge$/, () => 'mergeRun'],
  [/^\/api\/runs\/([^/]+)\/pull-request\/failing-checks\/prepare$/, () => 'prepare'],
  [
    /^\/api\/runs\/([^/]+)\/pull-request\/failing-checks\/prepared$/,
    (method) => (method === 'DELETE' ? 'discardPrepared' : 'prepared'),
  ],
  [/^\/api\/runs\/([^/]+)\/pull-request\/review-comments\/load$/, () => 'loadComments'],
  [/^\/api\/runs\/([^/]+)\/pull-request\/review-comments$/, () => 'comments'],
  [/^\/api\/runs\/([^/]+)\/events$/, () => 'events'],
  [/^\/api\/runs\/([^/]+)\/steps$/, () => 'steps'],
  [/^\/api\/runs\/([^/]+)\/events\/stream$/, () => 'stream'],
  [/^\/api\/runs\/([^/]+)\/diff$/, () => 'diff'],
  [/^\/api\/runs\/([^/]+)\/diff\/file$/, () => 'diffFile'],
  [
    /^\/api\/runs\/([^/]+)\/merge-review$/,
    (method) => (method === 'POST' ? 'requestMergeReview' : 'mergeReview'),
  ],
  [/^\/api\/runs\/([^/]+)\/merge-review\/file$/, () => 'mergeReviewFile'],
];

/** A Run's stored diff of one scope as the fake holds it: the file list with each file's patch. */
export type FakeDiff = Omit<RunDiffOutput, 'scope' | 'files'> & {
  files: (RunDiffOutput['files'][number] & { patch?: string })[];
};

/** A Run's merge review as the fake holds it: the file list with each file's patch. */
export type FakeMergeReview = Omit<MergeReviewOutput, 'files'> & {
  files: (MergeReviewOutput['files'][number] & { patch?: string })[];
};

/** One open live log connection of the fake: the test pushes events, ends or drops it. */
export interface FakeStream {
  runId: string;
  /** The `after` the client asked for. */
  after: number;
  push(...events: RunEventOutput[]): void;
  /** The Run is final and everything was sent (`event: end`). */
  end(): void;
  /** The connection breaks without `end`. */
  drop(): void;
  /** Whether the client aborted the request (e.g. the page went away). */
  aborted(): boolean;
}

export const PROJECT: ProjectOutput = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Acme Shop',
  mergeMethod: 'squash',
  kind: 'code',
  defaultAgent: null,
  createdAt: '2026-11-12T09:00:00.000Z',
};

export const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Both providers available: what `GET /api/providers` answers unless a test scripts it. */
export const BOTH_AVAILABLE: ProviderAvailabilityOutput[] = [
  { id: 'claude_code', name: 'Claude Code', available: true },
  { id: 'codex', name: 'Codex', available: true },
];

let nextRun = 1;

/** A Run of `PROJECT` with defaults; tests override what they look at. */
export function aRun(overrides: Partial<RunOutput> = {}): RunOutput {
  const n = nextRun++;
  const task = overrides.task ?? `Task number ${n}`;
  const createdAt = overrides.createdAt ?? '2026-11-15T10:00:00.000Z';
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    projectId: PROJECT.id,
    provider: 'claude_code',
    agent: {
      name: 'default-claude-code',
      source: 'built_in',
      commit: null,
      provider: 'claude_code',
      model: 'default',
      instructions: '',
    },
    task,
    state: 'queued',
    startCommit: SHA,
    createdAt,
    environmentFileSupplied: false,
    limits: { stepMinutes: 60, maxSteps: 10, waitingDays: 14, maxTotalSteps: 50 },
    // No Run step and no Follow-up yet.
    steps: { used: 0, usedInPart: 0 },
    followUps: 0,
    // The conversation starts with the Task.
    messages: [{ role: 'operator', kind: 'task', text: task, at: createdAt }],
    ...overrides,
  };
}

/** A second project, which the fake does not list (its name is unknown to the UI). */
export const OTHER_PROJECT_ID = '00000000-0000-4000-8000-0000000000b2';

export function fakeRunsApi(initial: RunOutput[] = []) {
  const runs = [...initial];
  const scripted: Record<Route, ScriptedResponse[]> = {
    projects: [],
    project: [],
    projectRuns: [],
    start: [],
    runs: [],
    summary: [],
    run: [],
    retryDelivery: [],
    resume: [],
    providers: [],
    agentWorker: [],
    cancel: [],
    answer: [],
    followUp: [],
    bringUp: [],
    refresh: [],
    closePullRequest: [],
    mergeRun: [],
    prepare: [],
    prepared: [],
    discardPrepared: [],
    loadComments: [],
    comments: [],
    events: [],
    steps: [],
    stream: [],
    diff: [],
    diffFile: [],
    mergeReview: [],
    requestMergeReview: [],
    mergeReviewFile: [],
  };
  const calls: { route: Route; body?: unknown; query?: URLSearchParams }[] = [];
  /** What `GET /api/agent-worker` answers: no worker connected by default. */
  let agentWorker: AgentWorkerOutput = { connected: false };
  /** Each Run's stored log and step results, as the API would hold them. */
  const logs = new Map<string, RunEventOutput[]>();
  const stepResults = new Map<string, RunStepOutput[]>();
  const streams: FakeStream[] = [];
  /** Each Run's prepared Follow-up of its failing checks. */
  const prepared = new Map<string, PreparedFollowUpOutput>();
  /** Each Run's loaded Review comments; a load only marks the set as loading. */
  const reviewComments = new Map<string, ReviewCommentsOutput>();
  /** Each Run's stored diffs by scope. */
  const diffs = new Map<string, Partial<Record<RunDiffOutput['scope'], FakeDiff>>>();
  /** Each Run's merge review with each file's patch; none until a test sets one or requests it. */
  const reviews = new Map<string, FakeMergeReview>();

  function openStream(runId: string, after: number, signal: AbortSignal): Response {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      controller.close();
    };
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(encoder.encode(': connected\n\n'));
      },
      cancel() {
        closed = true;
      },
    });
    let aborted = false;
    signal.addEventListener('abort', () => {
      aborted = true;
      close();
    });
    streams.push({
      runId,
      after,
      push(...events) {
        if (closed) return;
        for (const event of events) {
          controller.enqueue(
            encoder.encode(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        }
      },
      end() {
        if (closed) return;
        controller.enqueue(encoder.encode('event: end\ndata: {}\n\n'));
        close();
      },
      drop: close,
      aborted: () => aborted,
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  const fetch = vi.fn(async (request: Request): Promise<Response> => {
    const { pathname, searchParams } = new URL(request.url);
    const matched = ROUTES.map(([pattern, route]) => [pattern.exec(pathname), route] as const).find(
      ([match]) => match,
    );
    if (!matched) return json(404, problem(404, 'Not Found'));
    const [match, routeOf] = matched;
    const route = routeOf(request.method);
    const id = match![1];
    const body: unknown =
      route === 'start' ||
      route === 'answer' ||
      route === 'followUp' ||
      route === 'bringUp' ||
      route === 'mergeRun' ||
      route === 'loadComments'
        ? await request.json()
        : route === 'refresh'
          ? ((await request.json().catch(() => undefined)) as unknown)
          : undefined;
    calls.push({ route, body, query: searchParams });
    const response = scripted[route].shift();
    if (response) return json(response.status, response.body);
    switch (route) {
      case 'projects':
        return json(200, { items: [PROJECT] });
      case 'project':
        return id === PROJECT.id
          ? json(200, { ...PROJECT, repository: null })
          : json(404, problem(404, 'Project not found'));
      case 'projectRuns':
        return json(
          200,
          runs.filter((run) => run.projectId === id),
        );
      case 'runs':
        return json(200, [...runs]);
      case 'summary':
        // The API's counts: queued, preparing and running are under way.
        return json(200, {
          running: runs.filter((run) => ['queued', 'preparing', 'running'].includes(run.state))
            .length,
          waiting: runs.filter((run) => run.state === 'waiting_for_operator').length,
        });
      case 'providers':
        return json(200, BOTH_AVAILABLE);
      case 'agentWorker':
        return json(200, agentWorker);
      case 'run': {
        const run = runs.find((candidate) => candidate.id === id);
        return run ? json(200, run) : json(404, problem(404, 'Run not found'));
      }
      case 'cancel': {
        // The API's rules, in short.
        const index = runs.findIndex((candidate) => candidate.id === id);
        const run = runs[index];
        if (!run) return json(404, problem(404, 'Run not found'));
        if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(run.state)) {
          return json(
            409,
            problem(
              409,
              'Run already finished',
              'The run has already finished. There is nothing to cancel.',
            ),
          );
        }
        const cancelled: RunOutput =
          run.state === 'queued' || run.state === 'waiting_for_operator'
            ? {
                ...run,
                state: 'cancelled',
                finishedAt: new Date().toISOString(),
                cancellation: { by: 'operator', reason: 'Cancelled by the operator.' },
              }
            : { ...run, cancelRequestedAt: run.cancelRequestedAt ?? new Date().toISOString() };
        runs[index] = cancelled;
        return json(202, {
          outcome: cancelled.state === 'cancelled' ? 'cancelled' : 'cancel_requested',
        });
      }
      case 'answer': {
        // The API's rules, in short.
        const index = runs.findIndex((candidate) => candidate.id === id);
        const run = runs[index];
        if (!run) return json(404, problem(404, 'Run not found'));
        if (run.state !== 'waiting_for_operator') {
          return json(
            409,
            problem(409, 'Run not waiting for an answer', 'The run is not waiting for an answer.'),
          );
        }
        const { text } = body as { text: string };
        const { question: _question, ...rest } = run;
        void _question;
        const answered: RunOutput = {
          ...rest,
          state: 'queued',
          messages: [
            ...(run.messages ?? []),
            { role: 'operator', kind: 'answer', text, at: new Date().toISOString() },
          ],
        };
        runs[index] = answered;
        return new Response(null, { status: 202 });
      }
      case 'followUp': {
        // The API's rules, in short.
        const index = runs.findIndex((candidate) => candidate.id === id);
        const run = runs[index];
        if (!run) return json(404, problem(404, 'Run not found'));
        if (!run.followUp?.allowed) {
          return json(
            409,
            problem(409, 'Follow-up not possible', 'The run cannot take a Follow-up now.'),
          );
        }
        const { text, source, reviewCommentIds } = body as {
          text: string;
          source?: 'pull_request_checks' | 'review_comments';
          reviewCommentIds?: string[];
        };
        prepared.delete(run.id);
        const chosen = (reviewComments.get(run.id)?.comments ?? []).filter((comment) =>
          reviewCommentIds?.includes(comment.id),
        );
        if (source === 'review_comments') reviewComments.delete(run.id);
        const { failure: _failure, finishedAt: _finishedAt, delivery: _delivery, ...rest } = run;
        void _failure;
        void _finishedAt;
        void _delivery;
        const queued: RunOutput = {
          ...rest,
          state: 'queued',
          followUps: run.followUps + 1,
          steps: { used: run.steps.used, usedInPart: 0 },
          followUp: { allowed: false, reason: 'follow_up_queued' },
          messages: [
            ...(run.messages ?? []),
            {
              role: 'operator',
              kind: 'follow_up',
              text,
              ...(source ? { source } : {}),
              ...(source === 'review_comments'
                ? {
                    sourceCount: chosen.length,
                    sourceAuthors: [...new Set(chosen.map((comment) => comment.author))],
                  }
                : {}),
              at: new Date().toISOString(),
            },
          ],
        };
        runs[index] = queued;
        return new Response(null, { status: 202 });
      }
      case 'bringUp': {
        // A Follow-up of its own source; the note is optional.
        const index = runs.findIndex((candidate) => candidate.id === id);
        const run = runs[index];
        if (!run) return json(404, problem(404, 'Run not found'));
        if (!run.followUp?.allowed) {
          return json(
            409,
            problem(409, 'Follow-up not possible', 'The run cannot take a Follow-up now.'),
          );
        }
        const { note } = (body ?? {}) as { note?: string };
        const { failure: _failure, finishedAt: _finishedAt, delivery: _delivery, ...rest } = run;
        void _failure;
        void _finishedAt;
        void _delivery;
        const queued: RunOutput = {
          ...rest,
          state: 'queued',
          followUps: run.followUps + 1,
          steps: { used: run.steps.used, usedInPart: 0 },
          followUp: { allowed: false, reason: 'follow_up_queued' },
          messages: [
            ...(run.messages ?? []),
            {
              role: 'operator',
              kind: 'follow_up',
              text: note ?? '',
              source: 'bring_up_to_date',
              at: new Date().toISOString(),
            },
          ],
        };
        runs[index] = queued;
        return new Response(null, { status: 202 });
      }
      case 'refresh': {
        // The API only records a request; the Run comes back as it is. Tests move the pull
        // request on with `update`, as the agent worker's answer would.
        const run = runs.find((candidate) => candidate.id === id);
        if (!run) return json(404, problem(404, 'Run not found'));
        if (!run.pullRequest) {
          return json(409, problem(409, 'No pull request to refresh'));
        }
        return json(202, run);
      }
      case 'closePullRequest': {
        // The API's rules, in short: the close and the deletion both succeed.
        const index = runs.findIndex((candidate) => candidate.id === id);
        const run = runs[index];
        if (!run) return json(404, problem(404, 'Run not found'));
        if (!run.pullRequest || !['draft', 'open'].includes(run.pullRequest.state ?? '')) {
          return json(409, problem(409, 'The pull request is not open'));
        }
        const at = new Date().toISOString();
        runs[index] = {
          ...run,
          pullRequest: {
            ...run.pullRequest,
            state: 'closed',
            closedFromStudioAt: at,
            runBranchDeletedAt: at,
          },
        };
        return json(200, { state: 'closed', closedFromStudioAt: at, runBranchDeletedAt: at });
      }
      case 'mergeRun': {
        // The API's rules, in short: the merge and the steps after it all succeed.
        const index = runs.findIndex((candidate) => candidate.id === id);
        const run = runs[index];
        if (!run?.pullRequest) return json(404, problem(404, 'Run not found'));
        const at = new Date().toISOString();
        const { commit } = body as { commit: string };
        const earlier = run.latestMergeApproval;
        const approval = (earlier?.result === 'carried_out' ? earlier : undefined) ?? {
          id: '00000000-0000-4000-8000-0000000000e1',
          approvedAt: at,
          approvedBy: 'operator' as const,
          commit,
          integrationBranch: 'dev',
          method: 'squash' as const,
          checksSeen: [],
          result: 'carried_out' as const,
          mergedCommit: 'f'.repeat(40),
          completedAt: at,
        };
        const done = { ...approval, cloneFetchStartedAt: approval.cloneFetchStartedAt ?? at };
        const runBranchDeletedAt = run.pullRequest.runBranchDeletedAt ?? at;
        runs[index] = {
          ...run,
          pullRequest: { ...run.pullRequest, state: 'merged', runBranchDeletedAt },
          latestMergeApproval: done,
        };
        return json(200, { ...done, runBranchDeletedAt });
      }
      case 'prepare': {
        // The API only records a request; the Run comes back as it is. Tests move it on with
        // `update` and `setPrepared`, as the agent worker's answer would.
        const run = runs.find((candidate) => candidate.id === id);
        if (!run) return json(404, problem(404, 'Run not found'));
        if (!run.pullRequest) return json(409, problem(409, 'No pull request to read'));
        return json(202, run);
      }
      case 'loadComments': {
        // The API only records a request; the set comes back marked as loading. Tests move it on
        // with `setReviewComments`, as the agent worker's answer would.
        const run = runs.find((candidate) => candidate.id === id);
        if (!run) return json(404, problem(404, 'Run not found'));
        if (!run.pullRequest) return json(409, problem(409, 'No pull request to read'));
        const current = reviewComments.get(id!) ?? {
          comments: [],
          truncated: false,
          loading: false,
        };
        const loading = { ...current, loading: true };
        reviewComments.set(id!, loading);
        return json(202, loading);
      }
      case 'comments': {
        const run = runs.find((candidate) => candidate.id === id);
        if (!run) return json(404, problem(404, 'Run not found'));
        return json(
          200,
          reviewComments.get(id!) ?? { comments: [], truncated: false, loading: false },
        );
      }
      case 'prepared': {
        const draft = prepared.get(id!);
        return draft
          ? json(200, draft)
          : json(404, problem(404, 'No prepared Follow-up', 'The run has no prepared Follow-up.'));
      }
      case 'discardPrepared':
        prepared.delete(id!);
        return new Response(null, { status: 204 });
      case 'retryDelivery': {
        const index = runs.findIndex((candidate) => candidate.id === id);
        if (index === -1) return json(404, problem(404, 'Run not found'));
        runs[index] = { ...runs[index]!, deliveryRetryRequested: true };
        return new Response(null, { status: 202 });
      }
      case 'resume': {
        // Back to the queue, "Continue where you stopped." as the operator's answer.
        const index = runs.findIndex((candidate) => candidate.id === id);
        if (index === -1) return json(404, problem(404, 'Run not found'));
        const { failure, finishedAt, resumable, ...rest } = runs[index]!;
        void failure;
        void finishedAt;
        void resumable;
        const answer = {
          role: 'operator' as const,
          kind: 'answer' as const,
          text: 'Continue where you stopped.',
          at: new Date().toISOString(),
        };
        runs[index] = { ...rest, state: 'queued', messages: [...(rest.messages ?? []), answer] };
        return new Response(null, { status: 202 });
      }
      case 'events': {
        const after = Number(searchParams.get('after') ?? 0);
        const limit = Number(searchParams.get('limit') ?? 500);
        const rest = (logs.get(id!) ?? []).filter((event) => event.seq > after);
        const events = rest.slice(0, limit);
        return json(200, rest.length > limit ? { events, next: events.at(-1)!.seq } : { events });
      }
      case 'steps':
        return json(200, { steps: stepResults.get(id!) ?? [] });
      case 'diff': {
        const scope = searchParams.get('scope') as RunDiffOutput['scope'];
        const diff = diffs.get(id!)?.[scope];
        if (!diff) return json(404, problem(404, 'No diff yet'));
        return json(200, {
          ...diff,
          scope,
          files: diff.files.map(({ patch, ...file }) => {
            void patch;
            return file;
          }),
        });
      }
      case 'diffFile': {
        const scope = searchParams.get('scope') as RunDiffOutput['scope'];
        const file = diffs
          .get(id!)
          ?.[scope]?.files.find((candidate) => candidate.path === searchParams.get('path'));
        if (!file) return json(404, problem(404, 'File not in the diff'));
        const { additions, deletions, ...shown } = file;
        void additions;
        void deletions;
        return json(200, shown satisfies RunDiffFileOutput);
      }
      case 'mergeReview': {
        const review = reviews.get(id!);
        if (!review) return json(200, { state: 'none', files: [], truncated: false });
        return json(200, {
          ...review,
          files: review.files.map(({ patch, ...file }) => {
            void patch;
            return file;
          }),
        } satisfies MergeReviewOutput);
      }
      case 'requestMergeReview':
        reviews.set(id!, { state: 'preparing', files: [], truncated: false });
        return new Response(null, { status: 202 });
      case 'mergeReviewFile': {
        const file = reviews
          .get(id!)
          ?.files.find((candidate) => candidate.path === searchParams.get('path'));
        if (!file) return json(404, problem(404, 'File not in the review'));
        return json(200, file satisfies MergeReviewFileOutput);
      }
      case 'stream':
        return openStream(id!, Number(searchParams.get('after') ?? 0), request.signal);
      case 'start': {
        const { task, provider } = body as Pick<RunOutput, 'task' | 'provider'>;
        const run = aRun({
          projectId: id!,
          task: task.trim(),
          provider,
          createdAt: new Date().toISOString(),
        });
        runs.unshift(run);
        return json(201, { id: run.id });
      }
    }
  });
  vi.stubGlobal('fetch', fetch);

  return {
    /** Requests to `route`, in order. */
    calls: (route: Route) => calls.filter((call) => call.route === route),
    /** The next request to `route` gets this response instead of the default. */
    respondNext(route: Route, status: number, body: unknown) {
      scripted[route].push({ status, body });
    },
    /** Moves a Run on, as the agent worker would. */
    update(runId: string, change: Partial<RunOutput>) {
      const index = runs.findIndex((run) => run.id === runId);
      runs[index] = { ...runs[index]!, ...change };
    },
    /** The server's Runs, newest first. */
    runs: () => [...runs],
    /** Stores events in a Run's log (what the paged read returns). */
    storeEvents(runId: string, ...events: RunEventOutput[]) {
      logs.set(runId, [...(logs.get(runId) ?? []), ...events]);
    },
    /** Sets a Run's step results. */
    setSteps(runId: string, steps: RunStepOutput[]) {
      stepResults.set(runId, steps);
    },
    /** Sets a Run's stored diff of a scope. */
    setDiff(runId: string, scope: RunDiffOutput['scope'], diff: FakeDiff) {
      diffs.set(runId, { ...diffs.get(runId), [scope]: diff });
    },
    /** Sets a Run's merge review as the server would hold it. */
    setMergeReview(runId: string, review: FakeMergeReview) {
      reviews.set(runId, review);
    },
    /** Sets a Run's prepared Follow-up of its failing checks. */
    setPrepared(runId: string, draft: PreparedFollowUpOutput) {
      prepared.set(runId, draft);
    },
    /** Sets a Run's loaded Review comments, as the server would answer them. */
    setReviewComments(runId: string, set: ReviewCommentsOutput) {
      reviewComments.set(runId, set);
    },
    /** The Run's loaded Review comments on the server, if any. */
    reviewComments: (runId: string) => reviewComments.get(runId),
    /** Whether the Run still has a prepared Follow-up on the server. */
    hasPrepared: (runId: string) => prepared.has(runId),
    /** Sets what the agent worker's status answers. */
    setAgentWorker(status: AgentWorkerOutput) {
      agentWorker = status;
    },
    /** The live log connections opened so far, in order. */
    streams: () => [...streams],
  };
}

export function problem(
  status: number,
  title: string,
  detail = `${title}.`,
  errors?: ProblemDetails['errors'],
): ProblemDetails {
  return {
    type: 'about:blank',
    title,
    status,
    detail,
    correlationId: '00000000-0000-4000-8000-00000000c0de',
    ...(errors ? { errors } : {}),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });
}

/** A Run event with defaults (an output line of step 1). */
export function anEvent(seq: number, overrides: Partial<RunEventOutput> = {}): RunEventOutput {
  return {
    seq,
    at: '2026-11-15T10:00:10.000Z',
    stepIndex: 1,
    kind: 'output',
    text: `line ${seq}`,
    ...overrides,
  };
}
