// Features import from here, never from `./generated`. Same-origin `/api/...` paths: `next dev`
// rewrites them to the API, so no CORS. The session is an HttpOnly cookie: no code here reads it.
import * as sdk from './generated';
import type {
  SkillDetailOutput,
  SkillListOutput,
  AgentDetailOutput,
  AgentDraftOutput,
  AgentFileOutput,
  AgentFilesOutput,
  AgentListOutput,
  AgentWorkerOutput,
  AnswerRunRequest,
  BringUpToDateRequest,
  CancelRunResponseOutput,
  ClosePullRequestResponseOutput,
  ConnectRepositoryRequest,
  CreateProjectRequest,
  DefinitionsRepositoryOutput,
  EnvironmentFileInfoOutput,
  FollowUpRunRequest,
  ProblemDetails,
  ProjectDetailOutput,
  ProjectListOutput,
  LoadReviewCommentsRequest,
  MergeReviewFileOutput,
  MergeReviewOutput,
  MergeRunResponseOutput,
  ProjectOutput,
  PreparedFollowUpOutput,
  PreviewBuildEventsOutput,
  PreviewBuildOutput,
  PreviewLimitReachedProblem,
  PreviewOutput,
  PreviewRefusedProblem,
  PreviewsListOutput,
  ProviderListOutput,
  PublishAgentDraftRequest,
  PublishAgentDraftResultOutput,
  RefreshPullRequestRequest,
  RepositoryOutput,
  ReviewCommentsOutput,
  RunAgentListOutput,
  RunEventOutput,
  RunDiffFileOutput,
  RunDiffOutput,
  RunEventPageOutput,
  RunListOutput,
  RunOutput,
  RunsSummaryOutput,
  RunStepListOutput,
  SessionResponseOutput,
  SavePreviewSettingsRequest,
  SavePreviewSettingsResponseOutput,
  SetDefaultAgentRequest,
  SetEnvironmentFileRequest,
  SetMergeMethodRequest,
  StartRunRequest,
  StartRunResponseOutput,
  VerifyRepositoryRequest,
} from './generated';
import { client } from './generated/client.gen';
import {
  zBringUpToDateRequest,
  zConnectRepositoryRequest,
  zRunEventOutput,
  zCreateProjectRequest,
  zPreviewLimitReachedProblem,
  zPreviewRefusedProblem,
  zStartRunRequest,
} from './generated/zod.gen';

export type {
  SkillDetailOutput,
  SkillListOutput,
  SkillProblemOutput,
  SkillSummaryOutput,
  AgentDetailOutput,
  AgentDraftFileOutput,
  AgentDraftOutput,
  AgentDraftProblemOutput,
  AgentFileEntryOutput,
  AgentFileOutput,
  AgentFilesOutput,
  AgentListOutput,
  AgentProblemOutput,
  AgentSummaryOutput,
  AgentWorkerDiskOutput,
  AgentWorkerOutput,
  AnswerRunRequest,
  BringUpToDateRequest,
  CancelRunResponseOutput,
  ClosePullRequestResponseOutput,
  ConnectRepositoryRequest,
  CreateProjectRequest,
  DefinitionsRepositoryOutput,
  EnvironmentFileInfoOutput,
  FollowUpRunRequest,
  HealthResponseOutput,
  ProblemDetails,
  ProjectDetailOutput,
  ProjectListOutput,
  ProjectOutput,
  LoadReviewCommentsRequest,
  MergeReviewFileOutput,
  MergeReviewFileSummaryOutput,
  MergeApprovalOutput,
  MergeReviewOutput,
  MergeRunResponseOutput,
  PreparedFollowUpCheckOutput,
  PreparedFollowUpOutput,
  PreviewBuildEventsOutput,
  PreviewBuildOutput,
  PreviewLimitReachedProblem,
  PreviewOutput,
  PreviewRefusedProblem,
  PreviewsListOutput,
  ProviderAvailabilityOutput,
  ProviderListOutput,
  PublishAgentDraftRequest,
  PublishAgentDraftResultOutput,
  RefreshPullRequestRequest,
  RepositoryFailureCodeOutput,
  RepositoryOutput,
  RepositoryStateOutput,
  RepositorySummaryOutput,
  ReviewCommentOutput,
  ReviewCommentsOutput,
  RunAgentListOutput,
  RunAgentOptionOutput,
  RunAgentOutput,
  RunDiffFileOutput,
  RunDiffFileSummaryOutput,
  RunDiffOutput,
  RunEventOutput,
  RunEventPageOutput,
  RunListOutput,
  RunMessageOutput,
  RunOutput,
  RunPreviewAfterMergeOutput,
  RunQuestionOutput,
  RunsSummaryOutput,
  RunStepListOutput,
  RunStepOutput,
  SavePreviewSettingsRequest,
  SavePreviewSettingsResponseOutput,
  SessionResponseOutput,
  SetDefaultAgentRequest,
  SetEnvironmentFileRequest,
  SetMergeMethodRequest,
  StartRunRequest,
  StartRunResponseOutput,
  VerifyRepositoryRequest,
} from './generated';

/**
 * Generated from the OpenAPI document: client-side hints for forms only. The API applies
 * the full rules (e.g. whitespace normalization) and its 400/409 field errors are final.
 */
export const createProjectRequestHint = zCreateProjectRequest;

/** Generated hint for the Connect repository form; the API's 422 field errors are final. */
export const connectRepositoryRequestHint = zConnectRepositoryRequest;

/** Generated hint for the New run form; the API trims the Task and its 422 field errors are final. */
export const startRunRequestHint = zStartRunRequest;

/** The bring-up-to-date note's rules as a client-side hint; the API stays authoritative. */
export const bringUpToDateRequestHint = zBringUpToDateRequest;

client.setConfig({ credentials: 'same-origin' });

/** What a refused Preview save names: a code, a place in the file or the request, and fixed wording. */
export type PreviewRefusal = PreviewRefusedProblem['refusals'][number];

/**
 * The refusals of a 422 on saving the Preview settings, checked against the contract; none for
 * any other error.
 */
export function previewRefusalsOf(error: unknown): PreviewRefusal[] {
  if (!(error instanceof ApiError) || error.status !== 422) return [];
  const parsed = zPreviewRefusedProblem.safeParse(error.problem);
  return parsed.success ? parsed.data.refusals : [];
}

/**
 * The Previews running now, from a 409 on a build the limit refused, checked against the
 * contract; none for any other error.
 */
export function previewLimitOf(error: unknown): PreviewLimitReachedProblem | undefined {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const parsed = zPreviewLimitReachedProblem.safeParse(error.problem);
  return parsed.success ? parsed.data : undefined;
}

/** The problem type of a refusal because the Project is the definitions Repository. */
const DEFINITIONS_PROJECT_PROBLEM = 'urn:agentic-studio:problem:definitions-project';

/**
 * Whether a 409 says that the Project is the definitions Repository (it accepts no Run, no
 * Preview and no Environment file). The pages that offer those hide them for such a Project;
 * this is for the one that could still be reached by an old link or another tab.
 */
export function isDefinitionsRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.problem?.type === DEFINITIONS_PROJECT_PROBLEM
  );
}

/** Where the UI goes when the API answers 401. */
export const LOGIN_PATH = '/login';

/** A non-2xx API response, with its RFC 9457 problem details when the API sent them. */
export class ApiError extends Error {
  constructor(
    /** The HTTP status, or 0 when no response arrived (network error, abort, timeout). */
    readonly status: number,
    readonly problem: ProblemDetails | undefined,
    /** Seconds from a `Retry-After` header (429), if any. */
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(problem?.detail ?? `Request failed with status ${status}.`);
    this.name = 'ApiError';
  }
}

interface CallResult<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

interface CallOptions {
  /** On 401, send the browser to the login page (default). Login itself opts out. */
  redirectOnUnauthorized?: boolean;
}

function isProblem(value: unknown): value is ProblemDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProblemDetails).status === 'number' &&
    typeof (value as ProblemDetails).detail === 'string'
  );
}

/** A Repository in a response body (a 202 of a disconnect), checked rather than cast. */
function isRepository(value: unknown): value is RepositoryOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    typeof value.state === 'string' &&
    'url' in value &&
    typeof value.url === 'string'
  );
}

function redirectToLogin(): void {
  if (typeof window !== 'undefined' && window.location.pathname !== LOGIN_PATH) {
    // A full page load, not a client-side push: no protected UI state survives.
    window.location.replace(LOGIN_PATH);
  }
}

async function unwrap<T>(
  call: Promise<CallResult<T>>,
  { redirectOnUnauthorized = true }: CallOptions = {},
): Promise<T> {
  const { data, error, response } = await call;
  if (response?.ok) {
    return data as T;
  }
  const status = response?.status ?? 0;
  if (status === 401 && redirectOnUnauthorized) {
    redirectToLogin();
  }
  const retryAfter = Number(response?.headers.get('Retry-After'));
  throw new ApiError(
    status,
    isProblem(error) ? error : undefined,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

/** Generated operations with shared credentials, typed errors and 401 handling. */
export const api = {
  getHealth: () => unwrap(sdk.getHealth()),
  getSession: (): Promise<SessionResponseOutput> => unwrap(sdk.getSession()),
  login: (password: string): Promise<SessionResponseOutput> =>
    unwrap(sdk.login({ body: { password } }), { redirectOnUnauthorized: false }),
  logout: (): Promise<void> => unwrap(sdk.logout()),
  listProjects: (): Promise<ProjectListOutput> => unwrap(sdk.listProjects()),
  createProject: (body: CreateProjectRequest): Promise<ProjectOutput> =>
    unwrap(sdk.createProject({ body })),
  getDefinitionsRepository: (): Promise<DefinitionsRepositoryOutput> =>
    unwrap(sdk.getDefinitionsRepository()),
  listAgents: (): Promise<AgentListOutput> => unwrap(sdk.listAgents()),
  getAgent: (name: string): Promise<AgentDetailOutput> => unwrap(sdk.getAgent({ path: { name } })),
  listSkills: (): Promise<SkillListOutput> => unwrap(sdk.listSkills()),
  getSkill: (name: string): Promise<SkillDetailOutput> => unwrap(sdk.getSkill({ path: { name } })),
  listAgentFiles: (): Promise<AgentFilesOutput> => unwrap(sdk.listAgentFiles()),
  getAgentFile: (path: string, commit?: string): Promise<AgentFileOutput> =>
    unwrap(sdk.getAgentFile({ query: { path, commit } })),
  getAgentDraft: (): Promise<AgentDraftOutput> => unwrap(sdk.getAgentDraft()),
  getAgentDraftFile: (path: string): Promise<AgentFileOutput> =>
    unwrap(sdk.getAgentDraftFile({ query: { path } })),
  saveAgentDraftFile: (
    body: { path: string; text: string } | { path: string; contentBase64: string },
  ): Promise<AgentDraftOutput> => unwrap(sdk.saveAgentDraftFile({ body })),
  moveAgentDraftFile: (from: string, to: string): Promise<AgentDraftOutput> =>
    unwrap(sdk.moveAgentDraftFile({ body: { from, to } })),
  revertAgentDraftFile: (path: string): Promise<AgentDraftOutput> =>
    unwrap(sdk.revertAgentDraftFile({ body: { path } })),
  deleteAgentDraftFile: (path: string): Promise<AgentDraftOutput> =>
    unwrap(sdk.deleteAgentDraftFile({ query: { path } })),
  discardAgentDraft: (): Promise<AgentDraftOutput> => unwrap(sdk.discardAgentDraft()),
  publishAgentDraft: (body: PublishAgentDraftRequest): Promise<PublishAgentDraftResultOutput> =>
    unwrap(sdk.publishAgentDraft({ body })),
  getProject: (id: string): Promise<ProjectDetailOutput> =>
    unwrap(sdk.getProject({ path: { id } })),
  getRepository: (projectId: string): Promise<RepositoryOutput> =>
    unwrap(sdk.getRepository({ path: { id: projectId } })),
  connectRepository: (
    projectId: string,
    body: ConnectRepositoryRequest,
  ): Promise<RepositoryOutput> => unwrap(sdk.connectRepository({ path: { id: projectId }, body })),
  fetchRepository: (projectId: string): Promise<RepositoryOutput> =>
    unwrap(sdk.fetchRepository({ path: { id: projectId } })),
  /** "Verify and clone" of an SSH Repository; with a fingerprint, confirms the host key. */
  verifyRepository: (projectId: string, body: VerifyRepositoryRequest): Promise<RepositoryOutput> =>
    unwrap(sdk.verifyRepository({ path: { id: projectId }, body })),
  /**
   * `null` when the Repository is gone (204); the Repository in `disconnecting` when its
   * cleanup is still pending (202). A 202 without a Repository body is not taken as gone: it
   * fails like any unreadable answer.
   */
  disconnectRepository: async (projectId: string): Promise<RepositoryOutput | null> => {
    let status = 0;
    const data = await unwrap(
      sdk.disconnectRepository({ path: { id: projectId } }).then((result) => {
        status = result.response?.status ?? 0;
        return result;
      }),
    );
    if (status === 204) return null;
    if (!isRepository(data)) throw new Error('The disconnect answer has no Repository.');
    return data;
  },
  /** The project's Environment file (path, size, last change; never the content), or `null`. */
  getEnvironmentFile: (projectId: string): Promise<EnvironmentFileInfoOutput | null> =>
    unwrap(sdk.getEnvironmentFile({ path: { id: projectId } })),
  /** Sets or replaces the project's Environment file; the answer never has the content. */
  setEnvironmentFile: (
    projectId: string,
    body: SetEnvironmentFileRequest,
  ): Promise<EnvironmentFileInfoOutput> =>
    unwrap(sdk.setEnvironmentFile({ path: { id: projectId }, body })),
  /** The project's Preview: settings or `null`, hostname, and whether the Repository can be read. */
  getPreview: (projectId: string): Promise<PreviewOutput> =>
    unwrap(sdk.getPreview({ path: { id: projectId } })),
  /**
   * Saves the Preview settings once the API has judged the Compose file (200). A refusal answers
   * 422 with `refusals`; read them with {@link previewRefusalsOf}.
   */
  savePreviewSettings: (
    projectId: string,
    body: SavePreviewSettingsRequest,
  ): Promise<SavePreviewSettingsResponseOutput> =>
    unwrap(sdk.savePreviewSettings({ path: { id: projectId }, body })),
  /**
   * Asks for a build of the Preview (202: the queued build). A refusal answers 422 with
   * `refusals`; read them with {@link previewRefusalsOf}.
   */
  requestPreviewBuild: (projectId: string): Promise<PreviewBuildOutput> =>
    unwrap(sdk.requestPreviewBuild({ path: { id: projectId } })),
  /** One page of a build's log: the lines after `after`; `next` while more follow. */
  listPreviewBuildEvents: (
    projectId: string,
    buildId: string,
    after: number,
    limit: number,
  ): Promise<PreviewBuildEventsOutput> =>
    unwrap(
      sdk.listPreviewBuildEvents({ path: { id: projectId, buildId }, query: { after, limit } }),
    ),
  /** Stops the running Preview (202: the Preview, now `stopping`). A refusal answers 409. */
  stopPreview: (projectId: string): Promise<PreviewOutput> =>
    unwrap(sdk.stopPreview({ path: { id: projectId } })),
  /** Removes the Preview's volumes (202: the Preview, now `resetting_data`). A refusal answers 409. */
  resetPreviewData: (projectId: string): Promise<PreviewOutput> =>
    unwrap(sdk.resetPreviewData({ path: { id: projectId } })),
  /** The Projects whose Preview takes a place (running or building) and the limit. */
  listPreviews: (): Promise<PreviewsListOutput> => unwrap(sdk.listPreviews()),
  /** Removes the Preview settings (204, also when none were set). */
  removePreviewSettings: async (projectId: string): Promise<void> => {
    await unwrap(sdk.removePreviewSettings({ path: { id: projectId } }));
  },
  /** Sets how the project's Runs are merged (200: the project). */
  setMergeMethod: (projectId: string, body: SetMergeMethodRequest): Promise<ProjectOutput> =>
    unwrap(sdk.setMergeMethod({ path: { id: projectId }, body })),
  /** The usable agents a Run can start with, the one to offer first and why not the default. */
  listRunAgents: (projectId: string): Promise<RunAgentListOutput> =>
    unwrap(sdk.listRunAgents({ path: { id: projectId } })),
  /** Names the agent a Run offers first, or none (200: the project). A definitions Project answers 409. */
  setDefaultAgent: (projectId: string, body: SetDefaultAgentRequest): Promise<ProjectOutput> =>
    unwrap(sdk.setDefaultAgent({ path: { id: projectId }, body })),
  /** Removes the project's Environment file (204, also when none was set). */
  removeEnvironmentFile: async (projectId: string): Promise<void> => {
    await unwrap(sdk.removeEnvironmentFile({ path: { id: projectId } }));
  },
  /** Starts a Run on the project (201: the new Run's id; the Run is read from `getRun`). */
  startRun: (projectId: string, body: StartRunRequest): Promise<StartRunResponseOutput> =>
    unwrap(sdk.startRun({ path: { id: projectId }, body })),
  /** The project's Runs, newest first. */
  listProjectRuns: (projectId: string): Promise<RunListOutput> =>
    unwrap(sdk.listProjectRuns({ path: { id: projectId } })),
  /** Every Run across all projects, newest first. */
  listRuns: (): Promise<RunListOutput> => unwrap(sdk.listRuns()),
  getRunsSummary: (): Promise<RunsSummaryOutput> => unwrap(sdk.getRunsSummary()),
  getRun: (runId: string): Promise<RunOutput> => unwrap(sdk.getRun({ path: { runId } })),
  /** Repeats only the delivery of a Run whose delivery failed (202, no body). */
  retryRunDelivery: async (runId: string): Promise<void> => {
    await unwrap(sdk.retryRunDelivery({ path: { runId } }));
  },
  /**
   * Resumes a Run stopped at the usage limit (202, no body: the Run is queued to resume its agent
   * session with "Continue where you stopped.").
   */
  resumeRun: async (runId: string): Promise<void> => {
    await unwrap(sdk.resumeRun({ path: { runId } }));
  },
  /** Each provider and whether a Run can be started with it now, with the reason when not. */
  listProviders: (): Promise<ProviderListOutput> => unwrap(sdk.listProviders()),
  /**
   * Whether an agent worker is connected and the disk figures of its latest report: the Working
   * copies and caches, the Runs it keeps, and the free space with its threshold.
   */
  getAgentWorker: (): Promise<AgentWorkerOutput> => unwrap(sdk.getAgentWorker()),
  /**
   * Cancels a Run (202: `cancelled` when the Run was cancelled at once, `cancel_requested` when
   * the agent worker still has to confirm).
   */
  cancelRun: (runId: string): Promise<CancelRunResponseOutput> =>
    unwrap(sdk.cancelRun({ path: { runId } })),
  /**
   * Answers the agent's open question (202, no body). A Run that no longer waits answers 409; an
   * empty or too long answer 422 with field errors.
   */
  answerRun: async (runId: string, body: AnswerRunRequest): Promise<void> => {
    await unwrap(sdk.answerRun({ path: { runId }, body }));
  },
  /**
   * Sends a Follow-up to a finished Run (202, no body). A Run that cannot take one answers 409
   * saying why; an empty or too long text 422.
   */
  followUpRun: async (runId: string, body: FollowUpRunRequest): Promise<void> => {
    await unwrap(sdk.followUpRun({ path: { runId }, body }));
  },
  /**
   * Asks for a finished Run's branch to be brought up to date with the integration branch (202,
   * no body). The note is optional. A Run that cannot take a Follow-up answers 409 saying why; a
   * too long note 422.
   */
  bringUpToDateRun: async (runId: string, body: BringUpToDateRequest): Promise<void> => {
    await unwrap(sdk.bringUpToDateRun({ path: { runId }, body }));
  },
  /**
   * `onOpen` is the Run page's own request on opening, which the API takes at most once a minute
   * per Run. A Run without a pull request answers 409.
   */
  refreshRunPullRequest: (runId: string, body?: RefreshPullRequestRequest): Promise<RunOutput> =>
    unwrap(sdk.refreshRunPullRequest({ path: { runId }, ...(body ? { body } : {}) })),
  /**
   * Asks the agent worker to read the logs of the pull request's failing checks. Nothing is sent
   * to an agent.
   */
  /**
   * Closes the Run's pull request without merging and deletes its Run branch (200). Repeating it
   * after a failed deletion retries only the deletion.
   */
  closeRunPullRequest: (runId: string): Promise<ClosePullRequestResponseOutput> =>
    unwrap(sdk.closeRunPullRequest({ path: { runId } })),
  /**
   * Approves and merges the Run's pull request pinned to the commit the operator reviewed (200).
   * Repeating it after a merge retries only the steps still missing.
   */
  mergeRun: (runId: string, commit: string): Promise<MergeRunResponseOutput> =>
    unwrap(sdk.mergeRun({ path: { runId }, body: { commit } })),
  prepareRunFailingChecks: (runId: string): Promise<RunOutput> =>
    unwrap(sdk.prepareRunFailingChecks({ path: { runId } })),
  /** The Follow-up prepared from the failing checks, for review; 404 when none. */
  getRunPreparedFollowUp: (runId: string): Promise<PreparedFollowUpOutput> =>
    unwrap(sdk.getRunPreparedFollowUp({ path: { runId } })),
  /** Discards the prepared Follow-up without sending it. */
  discardRunPreparedFollowUp: async (runId: string): Promise<void> => {
    await unwrap(sdk.discardRunPreparedFollowUp({ path: { runId } }));
  },
  /**
   * Asks the agent worker to load the Review comments of the Run's pull request. Nothing is sent
   * to an agent.
   */
  loadRunReviewComments: (
    runId: string,
    body: LoadReviewCommentsRequest,
  ): Promise<ReviewCommentsOutput> => unwrap(sdk.loadRunReviewComments({ path: { runId }, body })),
  /** The Run's loaded Review comments and the state of the latest load. */
  getRunReviewComments: (runId: string): Promise<ReviewCommentsOutput> =>
    unwrap(sdk.getRunReviewComments({ path: { runId } })),
  /** One page of a Run's stored log: the events after `after`; `next` while more follow. */
  listRunEvents: (runId: string, after: number, limit: number): Promise<RunEventPageOutput> =>
    unwrap(sdk.listRunEvents({ path: { runId }, query: { after, limit } })),
  /** The structured result of each reported Run step. */
  listRunSteps: (runId: string): Promise<RunStepListOutput> =>
    unwrap(sdk.listRunSteps({ path: { runId } })),
  /**
   * A Run's diff: the whole Run or since the previous result; its file list without patches. 404
   * while no Run step has reported a result.
   */
  getRunDiff: (runId: string, scope: RunDiffOutput['scope']): Promise<RunDiffOutput> =>
    unwrap(sdk.getRunDiff({ path: { runId }, query: { scope } })),
  /** One file of a Run's diff with its patch, so a large diff loads per file. */
  getRunDiffFile: (
    runId: string,
    scope: RunDiffOutput['scope'],
    path: string,
  ): Promise<RunDiffFileOutput> =>
    unwrap(sdk.getRunDiffFile({ path: { runId }, query: { scope, path } })),

  /** The merge review Studio computed for a Run (`none` until one is requested). */
  getRunMergeReview: (runId: string): Promise<MergeReviewOutput> =>
    unwrap(sdk.getRunMergeReview({ path: { runId } })),

  /** Starts a merge review (202, no body: it is prepared in the background). */
  requestRunMergeReview: async (runId: string): Promise<void> => {
    await unwrap(sdk.requestRunMergeReview({ path: { runId } }));
  },

  getRunMergeReviewFile: (runId: string, path: string): Promise<MergeReviewFileOutput> =>
    unwrap(sdk.getRunMergeReviewFile({ path: { runId }, query: { path } })),
};

/**
 * `dropped` reconnects (also a 429: too many live logs open); `refused` is any other 4xx (the
 * session expired, or the Run is gone): reconnecting cannot help.
 */
export type RunEventStreamEnd = 'end' | 'dropped' | 'refused';

/** One stream message checked against the generated schema (the one list of event kinds). */
function isRunEvent(value: unknown): value is RunEventOutput {
  return zRunEventOutput.safeParse(value).success;
}

/**
 * `dropped` when the connection failed or closed early (or `signal` aborted, or a 429),
 * `refused` on another 4xx; reconnecting is the caller's (see `platform/realtime`). The
 * generated client does not retry here.
 */
export async function streamRunEvents(
  runId: string,
  after: number,
  handlers: { onOpen: () => void; onEvent: (event: RunEventOutput) => void; signal: AbortSignal },
): Promise<RunEventStreamEnd> {
  let opened = false;
  let ended = false;
  let status = 0;
  const { stream } = await sdk.streamRunEvents({
    path: { runId },
    query: { after },
    signal: handlers.signal,
    sseMaxRetryAttempts: 1,
    // Records the answer's status code, so a 4xx is told apart from a dropped connection.
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      status = response.status;
      return response;
    },
    onSseEvent: (message) => {
      if (!opened) {
        opened = true;
        handlers.onOpen();
      }
      if (message.event === 'end') ended = true;
    },
  });
  for await (const data of stream) {
    if (ended) break;
    if (isRunEvent(data)) handlers.onEvent(data);
  }
  if (status === 401) redirectToLogin();
  // Too many live logs open (429): a slot frees when another closes, so back off and try again
  // like after a drop instead of giving up.
  if (status === 429) return 'dropped';
  if (status >= 400 && status < 500) return 'refused';
  return ended ? 'end' : 'dropped';
}
