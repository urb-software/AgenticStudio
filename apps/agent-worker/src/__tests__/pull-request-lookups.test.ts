import type { LookupPayload, RunPayload } from '@agentic-studio/contracts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type BranchPosition,
  type PullRequestDetails,
  type PullRequestNumber,
  PullRequestFailedError,
  type PullRequestReader,
} from '../github.js';
import { type LookupApi, PullRequestLookups } from '../pull-request-lookups.js';

// Issue #142: the worker answers pull request lookups through the Agent account, after a scope
// check, with reads only. The Git host is a recording fake of the reader; the real client is
// tested against a stub of GitHub in github.test.ts.

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const BRANCH = 'agent/add-a-feature-r0b8e5c2d';
const AGENT = 'agent-bot';
const abort = new AbortController().signal;

const lookup = (overrides: Partial<LookupPayload> = {}): LookupPayload => ({
  id: 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f',
  kind: 'pull_request_state',
  runId: RUN_ID,
  repository: { remoteUrl: 'https://github.com/acme/shop.git' },
  pullRequestNumber: 7,
  runBranch: BRANCH,
  integrationBranch: 'dev',
  ...overrides,
});

const details = (overrides: Partial<PullRequestDetails> = {}): PullRequestDetails => ({
  url: 'https://github.com/acme/shop/pull/7',
  number: 7,
  state: 'open',
  merged: false,
  draft: false,
  mergeable: true,
  headRef: BRANCH,
  headRepository: 'acme/shop',
  author: AGENT,
  ...overrides,
});

/** A recording fake of the reader: what it was asked, and what it answers. */
class FakeReader implements PullRequestReader {
  readonly calls: string[] = [];
  pullRequest: PullRequestDetails | Error = details();
  branch: BranchPosition | null | Error = { behindBy: 2, aheadBy: 3 };
  viewerLogin: string | Error = AGENT;
  branchPresent = false;

  async details(pull: PullRequestNumber): Promise<PullRequestDetails> {
    this.calls.push(`details ${pull.owner}/${pull.repo}#${pull.number}`);
    if (this.pullRequest instanceof Error) throw this.pullRequest;
    return this.pullRequest;
  }
  async position(
    repository: { owner: string; repo: string },
    base: string,
    head: string,
  ): Promise<BranchPosition | null> {
    this.calls.push(`position ${repository.owner}/${repository.repo} ${base}...${head}`);
    if (this.branch instanceof Error) throw this.branch;
    return this.branch;
  }
  async branchExists(): Promise<boolean> {
    this.calls.push('branch');
    return this.branchPresent;
  }
  async viewer(): Promise<string> {
    this.calls.push('viewer');
    if (this.viewerLogin instanceof Error) throw this.viewerLogin;
    return this.viewerLogin;
  }
}

describe('PullRequestLookups', () => {
  let reader: FakeReader;
  let queue: LookupPayload[];
  let reported: [string, unknown][];
  let errors: string[];
  let token: string | undefined;
  let claimFailure: Error | undefined;

  const api: LookupApi = {
    claimLookups: async () => {
      if (claimFailure) throw claimFailure;
      return queue.splice(0);
    },
    reportLookup: async (id, answer) => {
      reported.push([id, answer]);
    },
  };
  const lookups = () =>
    new PullRequestLookups({
      api,
      github: { ...(token ? { token } : {}), apiUrl: 'https://api.example.test' },
      allowFileRemotes: false,
      reader: () => reader,
      logger: { info: () => undefined, error: (message) => errors.push(message) },
    });
  /** Serves one lookup and returns what was reported for it. */
  async function answerOf(overrides: Partial<LookupPayload> = {}) {
    queue.push(lookup(overrides));
    await lookups().serve(abort);
    return reported.at(-1)?.[1];
  }

  beforeEach(() => {
    reader = new FakeReader();
    queue = [];
    reported = [];
    errors = [];
    // A throwaway value; never a real token.
    token = 'test-token-value';
    claimFailure = undefined;
  });

  describe('states', () => {
    it('reports an open pull request with its branch position and the merge verdict', async () => {
      expect(await answerOf()).toEqual({
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'open', behindBy: 2, aheadBy: 3, mergeable: true },
      });
      expect(reader.calls).toEqual([
        'details acme/shop#7',
        'viewer',
        `position acme/shop dev...${BRANCH}`,
      ]);
    });

    it('reports a draft', async () => {
      reader.pullRequest = details({ draft: true, mergeable: false });

      expect(await answerOf()).toMatchObject({
        result: { state: 'draft', behindBy: 2, aheadBy: 3, mergeable: false },
      });
    });

    it('leaves the merge verdict out while GitHub has not worked it out', async () => {
      reader.pullRequest = details({ mergeable: null });

      const answer = (await answerOf()) as { result: object };

      expect(answer.result).toEqual({ state: 'open', behindBy: 2, aheadBy: 3 });
    });

    it('reports a merged pull request, whatever happened to its branch', async () => {
      reader.pullRequest = details({ state: 'closed', merged: true });
      reader.branch = null;

      expect(await answerOf()).toEqual({
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'merged' },
      });
      expect(reader.calls).not.toContain(`position acme/shop dev...${BRANCH}`);
    });

    it('reports a closed pull request without a merge verdict', async () => {
      reader.pullRequest = details({ state: 'closed', mergeable: false });

      expect(await answerOf()).toMatchObject({
        result: { state: 'closed', behindBy: 2, aheadBy: 3 },
      });
      expect(((await answerOf()) as { result: object }).result).not.toHaveProperty('mergeable');
    });

    it('reports a pull request that no longer exists as missing', async () => {
      reader.pullRequest = new PullRequestFailedError('GitHub answered 404', 404);

      expect(await answerOf()).toEqual({
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'missing' },
      });
    });

    it('reports a failure, not a missing pull request, when only the comparison answered 404 (review S3 of #152)', async () => {
      reader.branch = null;
      reader.branchPresent = true;

      expect(await answerOf()).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringContaining('integration branch'),
      });
    });

    it('reports a deleted Run branch as missing', async () => {
      reader.branch = null;

      expect(await answerOf()).toEqual({
        ok: true,
        kind: 'pull_request_state',
        result: { state: 'missing' },
      });
    });
  });

  describe('scope: only the Run own repository and pull request', () => {
    const rejected = {
      ok: false,
      code: 'scope_mismatch',
      error: expect.any(String),
    };

    it.each([
      ['a GitLab remote', { repository: { remoteUrl: 'https://gitlab.com/acme/shop.git' } }],
      ['a look-alike host', { repository: { remoteUrl: 'https://github.com.evil.test/a/b.git' } }],
      ['a file remote in production', { repository: { remoteUrl: 'file:///tmp/acme/shop.git' } }],
    ])('rejects %s before it reads anything', async (_name, overrides) => {
      expect(await answerOf(overrides)).toMatchObject(rejected);
      expect(reader.calls).toEqual([]);
    });

    it.each([
      ['the integration branch', { runBranch: 'dev' }],
      ['another branch', { runBranch: 'feature/other' }],
      ['another Run branch', { runBranch: 'agent/add-a-feature-rffffffff' }],
    ])('rejects %s as the Run branch before it reads anything', async (_name, overrides) => {
      expect(await answerOf(overrides)).toMatchObject(rejected);
      expect(reader.calls).toEqual([]);
    });

    it('rejects a pull request from another branch, without reading the branch position', async () => {
      reader.pullRequest = details({ headRef: 'agent/something-else-r0b8e5c2d' });

      expect(await answerOf()).toMatchObject(rejected);
      expect(reader.calls.some((call) => call.startsWith('position'))).toBe(false);
    });

    it('rejects a pull request from another repository (a fork)', async () => {
      reader.pullRequest = details({ headRepository: 'mallory/shop' });

      expect(await answerOf()).toMatchObject(rejected);
      reader.pullRequest = details({ headRepository: null });
      expect(await answerOf()).toMatchObject(rejected);
    });

    it('rejects a pull request the Agent account did not open', async () => {
      reader.pullRequest = details({ author: 'someone-else' });

      expect(await answerOf()).toMatchObject(rejected);
      expect(reader.calls.some((call) => call.startsWith('position'))).toBe(false);
    });

    it('never sends a write request: it only has the three reads', async () => {
      await answerOf();

      expect(reader.calls.every((call) => /^(details|position|viewer)/.test(call))).toBe(true);
    });
  });

  describe('errors and rate limits', () => {
    it('reports a rate limit with how long to wait, never as a failure of the Run', async () => {
      reader.pullRequest = new PullRequestFailedError('GitHub answered 429', 429, 120);

      expect(await answerOf()).toEqual({
        ok: false,
        code: 'rate_limited',
        error: expect.stringContaining('120 seconds'),
        retryAfterSeconds: 120,
      });
    });

    it('reports GitHub refusing the read, with what to check', async () => {
      reader.pullRequest = new PullRequestFailedError(
        'Reading the pull request failed: GitHub answered 401. Check the token.',
        401,
      );

      expect(await answerOf()).toEqual({
        ok: false,
        code: 'failed',
        error: 'Reading the pull request failed: GitHub answered 401. Check the token.',
      });
    });

    it('reports that the Agent account is not configured, reading nothing', async () => {
      token = undefined;

      expect(await answerOf()).toMatchObject({
        ok: false,
        code: 'failed',
        error: expect.stringContaining('STUDIO_AGENT_GITHUB_TOKEN'),
      });
      expect(reader.calls).toEqual([]);
    });

    it('reports an unexpected error generally and logs the details, never the token', async () => {
      reader.pullRequest = new Error('socket hang up');

      const answer = await answerOf();

      expect(answer).toEqual({
        ok: false,
        code: 'failed',
        error: 'The lookup failed. The agent worker log has the details.',
      });
      expect(errors.join('\n')).toContain('socket hang up');
      expect(errors.join('\n')).not.toContain('test-token-value');
    });

    it('asks who the Agent account is once, and again after a failed attempt', async () => {
      const service = lookups();
      queue.push(lookup(), lookup());
      await service.serve(abort);
      expect(reader.calls.filter((call) => call === 'viewer')).toHaveLength(1);

      reader.viewerLogin = new PullRequestFailedError('GitHub answered 401', 401);
      const fresh = lookups();
      queue.push(lookup());
      await fresh.serve(abort);
      expect(reported.at(-1)?.[1]).toMatchObject({ ok: false, code: 'failed' });
      reader.viewerLogin = AGENT;
      queue.push(lookup());
      await fresh.serve(abort);
      expect(reported.at(-1)?.[1]).toMatchObject({ ok: true });
    });

    it('answers each claimed lookup, and a lookup it cannot report does not stop the others', async () => {
      const failing = lookup({ id: 'a4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f' });
      queue.push(failing, lookup());
      let first = true;
      const service = new PullRequestLookups({
        api: {
          claimLookups: api.claimLookups,
          reportLookup: async (id, answer) => {
            if (first) {
              first = false;
              throw new Error('Studio is unreachable');
            }
            reported.push([id, answer]);
          },
        },
        github: { token: 'test-token-value', apiUrl: 'https://api.example.test' },
        allowFileRemotes: false,
        reader: () => reader,
        logger: { info: () => undefined, error: (message) => errors.push(message) },
      });

      expect(await service.serve(abort)).toBe(2);

      expect(reported).toHaveLength(1);
      expect(errors.join('\n')).toContain('Reporting lookup');
    });

    it('hands the failure of a claim to its caller', async () => {
      claimFailure = new Error('The Studio API answered 500');

      await expect(lookups().serve(abort)).rejects.toThrow('500');
    });

    it('reports nothing when the worker is stopping', async () => {
      const stopping = new AbortController();
      reader.pullRequest = new Error('aborted');
      queue.push(lookup());
      const service = new PullRequestLookups({
        api,
        github: { token: 'test-token-value', apiUrl: 'https://api.example.test' },
        allowFileRemotes: false,
        reader: () => ({
          ...reader,
          details: async () => {
            stopping.abort();
            throw new Error('aborted');
          },
          viewer: async () => AGENT,
          position: async () => null,
          branchExists: async () => true,
        }),
        logger: { info: () => undefined, error: () => undefined },
      });

      await service.serve(stopping.signal);

      expect(reported).toEqual([]);
    });
  });

  describe('the pull request state before a Follow-up', () => {
    const resume = (overrides: Partial<RunPayload> = {}): RunPayload => ({
      runId: RUN_ID,
      projectId: '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b',
      provider: 'codex',
      task: 'Add a feature',
      startCommit: 'a'.repeat(40),
      repository: { remoteUrl: 'https://github.com/acme/shop.git' },
      integrationBranch: 'dev',
      kind: 'resume',
      runBranch: BRANCH,
      sessionRef: 'session-1',
      answer: 'Go on.',
      resumeReason: 'follow_up',
      followUpNumber: 1,
      pullRequestNumber: 7,
      nextSeq: 5,
      studioPaths: [],
      limits: { stepMinutes: 60, maxSteps: 10 },
      completedSteps: 1,
      ...overrides,
    });

    it.each([
      ['merged', { state: 'closed' as const, merged: true }],
      ['closed', { state: 'closed' as const }],
      ['open', {}],
      ['draft', { draft: true }],
    ])('reads it as %s', async (state, overrides) => {
      reader.pullRequest = details(overrides);

      expect(await lookups().followUpState(resume(), abort)).toBe(state);
    });

    it('reads a deleted pull request as missing', async () => {
      reader.pullRequest = new PullRequestFailedError('GitHub answered 404', 404);

      expect(await lookups().followUpState(resume(), abort)).toBe('missing');
    });

    it('says unknown when it cannot be read: a rate limit, an error, a foreign pull request', async () => {
      reader.pullRequest = new PullRequestFailedError('GitHub answered 429', 429, 60);
      expect(await lookups().followUpState(resume(), abort)).toBe('unknown');
      reader.pullRequest = new Error('socket hang up');
      expect(await lookups().followUpState(resume(), abort)).toBe('unknown');
      reader.pullRequest = details({ author: 'someone-else' });
      expect(await lookups().followUpState(resume(), abort)).toBe('unknown');
      token = undefined;
      expect(await lookups().followUpState(resume(), abort)).toBe('unknown');
    });

    it('says unknown for a Run that recorded no pull request', async () => {
      expect(await lookups().followUpState(resume({ pullRequestNumber: undefined }), abort)).toBe(
        'unknown',
      );
      expect(reader.calls).toEqual([]);
    });
  });
});

// Issue #142: the lookups start no agent CLI, and nothing they import can: the modules that
// spawn processes (the spawn boundary, the runners, Git) are not in their import closure.
describe('what pull request lookups can reach', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');

  /** Every local module `entry` imports, directly or not (source text, relative imports only). */
  function closure(entry: string): Set<string> {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(join(src, file), 'utf8');
      for (const match of text.matchAll(/from '(\.{1,2}\/[^']+)\.js'/g)) {
        visit(join(dirname(file), match[1]!).replaceAll('\\', '/') + '.ts');
      }
    };
    visit(entry);
    return seen;
  }

  it('does not import the spawn boundary, a runner, the process runner or Git', () => {
    const reachable = [...closure('pull-request-lookups.ts')].map((file) =>
      file.replace(/\.ts$/, ''),
    );
    const forbidden = reachable.filter((file) =>
      /(^|\/)(spawn-boundary|process-runner|process-identity|runner|runner-dispatcher|git|step-processes|working-copy|delivery|fake-runner|claude-code\/.*|codex\/.*)$/.test(
        file,
      ),
    );
    expect(forbidden).toEqual([]);
    // Guard against a vacuous pass: the walk did reach its own imports.
    expect(reachable).toEqual(
      expect.arrayContaining(['pull-request-lookups', 'github', 'studio-api', 'run-branch']),
    );
  });
});
