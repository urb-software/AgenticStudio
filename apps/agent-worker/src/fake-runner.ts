import type { RunPayload, RunStepResult } from '@agentic-studio/contracts';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GIT_TIMEOUTS, type GitOptions, GitRunner, SAFE_DIFF_FLAGS } from './git.js';
import {
  AgentFailedError,
  type ResumeRunStepInput,
  type Runner,
  type RunStep,
  type RunWorkspace,
  type StartRunStepInput,
} from './runner.js';

/** The scripted outcomes, chosen by a marker in the Task text (`[fake:<scenario>]`). */
export const FAKE_SCENARIOS = [
  'success',
  'fail',
  'question',
  'question-twice',
  'lost-session',
  'slow',
  'crash',
  'commit',
  'dirty',
  'stubborn',
  'long',
  'checks-failed',
  'secret',
  'print-env',
  'two-files',
  'resolve-conflicts',
  'resolve-in-tree',
  'copy-agent-file',
] as const;
export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

const MARKER = /\[fake:([a-z-]+)\]/;

/**
 * What a fake review Phase does, chosen by `[fake-review:<verdict>]` in the Task (a work Phase
 * ignores it): approve, ask for changes, end without a Verdict, change the Working copy and commit
 * it as a careless reviewer could (then approve), or ask a question.
 */
export const FAKE_REVIEW_SCENARIOS = ['approved', 'changes', 'none', 'edits', 'question'] as const;
export type FakeReviewScenario = (typeof FAKE_REVIEW_SCENARIOS)[number];

const REVIEW_MARKER = /\[fake-review:([a-z-]+)\]/;

/** The review a Task asks for; `approved` without a (known) marker. */
export function fakeReviewScenarioOf(task: string): FakeReviewScenario {
  const named = REVIEW_MARKER.exec(task)?.[1];
  return (FAKE_REVIEW_SCENARIOS as readonly string[]).includes(named ?? '')
    ? (named as FakeReviewScenario)
    : 'approved';
}

/** The file the `edits` review adds to the Working copy; it must never reach a commit. */
export const FAKE_REVIEW_FILE = 'FAKE_REVIEW_EDIT.md';

/** The findings of the `changes` review: one that names a file, one that is text with markup. */
export const FAKE_REVIEW_FINDINGS = [
  { text: 'The fake review found a problem here.', file: 'FAKE_CHANGE.md', line: 1 },
  { text: '<b>Not bold</b> and *not emphasised*, [not a link](https://example.test).' },
] as const;

/** The scenario a Task asks for; `success` without a (known) marker. */
export function fakeScenarioOf(task: string): FakeScenario {
  const named = MARKER.exec(task)?.[1];
  return (FAKE_SCENARIOS as readonly string[]).includes(named ?? '')
    ? (named as FakeScenario)
    : 'success';
}

export interface FakeRunnerOptions {
  /** How long the `slow` scenario works before it succeeds (it stops early when aborted). */
  slowMs?: number;
  /** How long the `long` scenario works; it stops when aborted. */
  longMs?: number;
  /** How often the `slow` scenario prints a line while it works. */
  slowLineMs?: number;
  /** Git for the `commit` scenario (default: the worker's hardened runner). */
  git?: GitRunner;
  /** The Agent account its commits are made as (default: the Working copy's own). */
  identity?: { name: string; email: string };
}

/**
 * What the fake runner reports of an agent from a definitions Repository: the commit, the base
 * rules' version and the instructions as a size and a digest, never their text. A built-in
 * agent reports nothing, so a Run of the Default agent logs exactly what it always did.
 */
export function fakeAgentLine(run: Pick<RunPayload, 'baseRules' | 'agent'>): string | null {
  const { agent } = run;
  if (agent.source === 'built_in') return null;
  const digest = createHash('sha256').update(agent.instructions).digest('hex');
  return (
    `fake runner: agent ${agent.name} at ${agent.commit}, model ${agent.model}; ` +
    `base rules ${run.baseRules.version}; ` +
    `instructions ${Buffer.byteLength(agent.instructions)} bytes, sha256 ${digest}`
  );
}

/**
 * What the fake runner reports of the agent's files: how many, and each by relative path, mode and
 * digest, never content or the folder's own path. It only reads: nothing in the folder is run.
 * `null` without a folder.
 */
export async function fakeAgentFolderLine(dir: string | null | undefined): Promise<string | null> {
  if (!dir) return null;
  const listed: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) listed.push(path);
    }
  };
  await walk('');
  const described: string[] = [];
  for (const path of listed.sort()) {
    const mode = ((await lstat(join(dir, path))).mode & 0o777).toString(8).padStart(4, '0');
    const digest = createHash('sha256')
      .update(await readFile(join(dir, path)))
      .digest('hex');
    described.push(`${path} ${mode} sha256 ${digest}`);
  }
  return `fake runner: agent folder ${described.length} files: ${described.join(', ')}`;
}

/** What the fake runner reports of the placed skills: their names, never a path or any content. */
export function fakeSkillsLine(skills: readonly { name: string }[] | undefined): string | null {
  if (!skills || skills.length === 0) return null;
  return `fake runner: skills ${skills.map((skill) => skill.name).join(', ')}`;
}

/**
 * The fake agent's session reference: deterministic, per Run, and per Phase after the first (each
 * Phase of a Workflow Run has a session of its own).
 */
export function fakeSessionRef(runId: string, position = 0): string {
  return position === 0 ? `fake-session-${runId}` : `fake-session-${runId}-phase-${position}`;
}

/** What the fake runner logs of the Phase and of what the Phase before reported; no text of an agent. */
export function fakePhaseLines(run: Pick<StartRunStepInput['run'], 'phase'>): string[] {
  const { phase } = run;
  if (phase === undefined) return [];
  const lines = [`fake runner: phase ${phase.itemId} (${phase.position + 1}/${phase.count})`];
  if (phase.previous !== undefined) {
    lines.push(`fake runner: told by phase ${phase.previous.itemId}: ${phase.previous.summary}`);
  }
  return lines;
}

/** The fake agent's question, with options and a recommendation. */
function asking(runId: string, text: string, position = 0): RunStepResult {
  return {
    outcome: 'needs_input',
    summary: 'The fake agent needs a decision.',
    question: { text, options: ['Option A', 'Option B'], recommendation: 'Option A' },
    sessionRef: fakeSessionRef(runId, position),
  };
}

/** The file the `commit` and `dirty` scenarios write in the Working copy. */
export const FAKE_CHANGE_FILE = 'FAKE_CHANGE.md';

/** The file a Follow-up's `commit` and `dirty` scenarios write. */
export const FAKE_FOLLOW_UP_FILE = 'FAKE_FOLLOW_UP.md';
/** The second file of the `two-files` scenario, left uncommitted. */
export const FAKE_NOTES_FILE = 'FAKE_NOTES.md';

/**
 * A token-shaped string for the `secret` scenario: GitHub's personal token shape, made of a
 * fixed pattern so it is obviously not a real token. Studio must redact it before storing.
 */
const FAKE_TOKEN = `ghp_${'fake0TOKEN0for0redaction0'.repeat(2).slice(0, 36)}`;

/**
 * Runner with scripted outcomes ({@link FakeScenario}): deterministic, no provider, no network.
 * `resume` continues only the Run's own session; a Follow-up or bring-up note plays the scenario
 * its text names; `print-env` prints Studio-placed files. See docs/architecture/agent-worker.md.
 */
export class FakeRunner implements Runner {
  private readonly slowMs: number;
  private readonly slowLineMs: number;
  private readonly longMs: number;
  private readonly git: GitRunner;
  private readonly commitConfig: NonNullable<GitOptions['config']>;

  constructor(options: FakeRunnerOptions = {}) {
    this.slowMs = options.slowMs ?? 5000;
    this.slowLineMs = options.slowLineMs ?? 500;
    this.longMs = options.longMs ?? 10 * 60_000;
    this.git = options.git ?? new GitRunner();
    this.commitConfig = [
      ...(options.identity
        ? ([
            ['user.name', options.identity.name],
            ['user.email', options.identity.email],
          ] as const)
        : []),
      ['commit.gpgSign', 'false'],
    ];
  }

  /**
   * Like a real runner, every result names the agent session the step ran in, so a
   * finished Run can take a Follow-up.
   */
  async *start(input: StartRunStepInput): RunStep {
    return withSession(input.run, yield* this.startStep(input));
  }

  async *resume(input: ResumeRunStepInput): RunStep {
    return withSession(input.run, yield* this.resumeStep(input));
  }

  private async *startStep({ run, workspace, signal }: StartRunStepInput): RunStep {
    const scenario = fakeScenarioOf(run.task);
    yield { type: 'message', text: `fake runner: ${scenario}` };
    const agentLine = fakeAgentLine(run);
    if (agentLine !== null) yield { type: 'message', text: agentLine };
    for (const text of fakePhaseLines(run)) yield { type: 'message', text };
    const folderLine = await fakeAgentFolderLine(workspace.agentFolder);
    if (folderLine !== null) yield { type: 'message', text: folderLine };
    const skillsLine = fakeSkillsLine(workspace.skills);
    if (skillsLine !== null) yield { type: 'message', text: skillsLine };
    if (run.phase?.kind === 'review') return yield* this.review(run, workspace, signal);
    return yield* this.play(scenario, run, workspace, signal, false);
  }

  /**
   * Plays a scenario: a first step's, or a Follow-up's, whose `commit` writes
   * {@link FAKE_FOLLOW_UP_FILE} with new content, so every Follow-up makes a new commit.
   */
  private async *play(
    scenario: FakeScenario,
    run: StartRunStepInput['run'],
    workspace: RunWorkspace,
    signal: AbortSignal,
    followUp: boolean,
  ): RunStep {
    if (scenario !== 'stubborn') signal.throwIfAborted();
    const change = (commit: boolean) =>
      followUp
        ? this.followUpChange(workspace, signal, run.completedSteps, commit)
        : this.change(workspace, signal, commit);
    const changed = followUp ? FAKE_FOLLOW_UP_FILE : FAKE_CHANGE_FILE;
    switch (scenario) {
      case 'fail':
        throw new AgentFailedError('The fake agent failed.');
      case 'crash':
        throw new Error('The fake runner crashed.');
      case 'question':
      case 'question-twice':
      case 'lost-session':
        return asking(run.runId, 'Which option should the fake agent take?', run.phase?.position);
      case 'slow': {
        yield { type: 'command', text: 'fake-work --slowly' };
        const started = Date.now();
        for (let line = 1; Date.now() - started < this.slowMs; line++) {
          yield { type: 'output', text: `working slowly: line ${line}` };
          await delay(this.slowLineMs, undefined, { signal });
        }
        // Wider than a phone: the log viewer scrolls it sideways, never the page.
        yield { type: 'output', text: `wide output: ${'0123456789'.repeat(30)}` };
        return done();
      }
      case 'long': {
        yield { type: 'command', text: 'fake-work --for-a-long-time' };
        const started = Date.now();
        for (let line = 1; Date.now() - started < this.longMs; line++) {
          yield { type: 'output', text: `working for a long time: line ${line}` };
          await delay(this.slowLineMs, undefined, { signal });
        }
        return done();
      }
      case 'secret':
        yield { type: 'command', text: 'printenv GITHUB_TOKEN' };
        yield { type: 'output', text: FAKE_TOKEN };
        return done();
      case 'print-env':
        for (const path of run.studioPaths) {
          yield { type: 'command', text: `cat ${path}` };
          yield { type: 'output', text: await readFile(join(workspace.repoDir, path), 'utf8') };
        }
        return done();
      case 'stubborn':
        yield { type: 'output', text: 'working, and ignoring every request to stop' };
        // Deliberately no signal: the timer is unref'd so it never keeps the process alive.
        await delay(this.slowMs, undefined, { ref: false });
        return done();
      case 'commit':
        await change(true);
        yield { type: 'output', text: `committed ${changed}` };
        return done();
      case 'dirty':
        await change(false);
        yield { type: 'output', text: `left ${changed} uncommitted` };
        return done();
      case 'two-files':
        await this.change(workspace, signal, true);
        await this.write(workspace, FAKE_NOTES_FILE, 'Notes left by the fake runner.\n');
        yield { type: 'output', text: `committed ${FAKE_CHANGE_FILE}; left ${FAKE_NOTES_FILE}` };
        return done();
      case 'copy-agent-file': {
        const copied = await this.copyAgentFile(workspace, signal);
        yield { type: 'output', text: `committed ${copied}, a copy of a file of the agent folder` };
        return done();
      }
      case 'checks-failed':
        await change(true);
        yield { type: 'output', text: `committed ${changed}; a check failed` };
        return {
          ...done(),
          checks: [
            { name: 'fake check', result: 'passed' },
            { name: 'fake unit tests', result: 'failed', detail: '1 of 12 tests failed.' },
          ],
        };
      case 'resolve-conflicts':
      case 'resolve-in-tree':
      case 'success':
        yield { type: 'command', text: 'fake-test --all' };
        yield { type: 'output', text: 'done' };
        return done();
    }
  }

  /** A review Phase: reads the change, may misbehave (`edits`), and ends with its Verdict. */
  private async *review(
    run: StartRunStepInput['run'],
    workspace: RunWorkspace,
    signal: AbortSignal,
  ): RunStep {
    const scenario = fakeReviewScenarioOf(run.task);
    yield { type: 'command', text: 'git status --short' };
    yield { type: 'output', text: `reviewing: ${scenario}` };
    signal.throwIfAborted();
    switch (scenario) {
      case 'question':
        return asking(
          run.runId,
          'Which of the changes should the review look at?',
          run.phase?.position,
        );
      case 'edits': {
        // What a careless review does: edits a file, adds one and commits.
        await this.write(workspace, FAKE_REVIEW_FILE, 'Written by a fake review.\n');
        await this.write(workspace, FAKE_CHANGE_FILE, 'Rewritten by a fake review.\n');
        const options = { cwd: workspace.repoDir, timeoutMs: GIT_TIMEOUTS.local, signal };
        await this.git.run(['add', '--', FAKE_REVIEW_FILE, FAKE_CHANGE_FILE], options);
        await this.git.run(['commit', '--quiet', '--no-verify', '-m', 'Fake review edit'], {
          ...options,
          config: this.commitConfig,
        });
        await this.write(workspace, 'FAKE_REVIEW_LEFTOVER.md', 'Left by a fake review.\n');
        yield { type: 'output', text: 'edited, added and committed files (it must not count)' };
        return { outcome: 'done', summary: 'The fake review approved it.', verdict: 'approved' };
      }
      case 'none':
        return { outcome: 'done', summary: 'The fake review forgot its Verdict.' };
      case 'changes':
        return {
          outcome: 'done',
          summary: 'The fake review asks for changes.',
          verdict: 'changes_requested',
          findings: FAKE_REVIEW_FINDINGS.map((finding) => ({ ...finding })),
        };
      case 'approved':
        return { outcome: 'done', summary: 'The fake review approved it.', verdict: 'approved' };
    }
  }

  /**
   * Resolves every conflicted file of the merge left open in the Working copy, and
   * stages each when `stage`. Returns the paths. Never writes through a symlink.
   */
  private async resolveConflicts(workspace: RunWorkspace, signal: AbortSignal, stage: boolean) {
    const options = { cwd: workspace.repoDir, timeoutMs: GIT_TIMEOUTS.local, signal };
    const listed = await this.git.run(
      ['diff', ...SAFE_DIFF_FLAGS, '--name-only', '--diff-filter=U', '-z'],
      options,
    );
    const paths = listed.split('\0').filter((path) => path !== '');
    for (const path of paths) {
      if (path.split('/').some((part) => part === '..' || part === '.')) continue;
      const file = join(workspace.repoDir, path);
      await rm(file, { force: true });
      await writeFile(file, `Resolved by the fake runner.\n`, { flag: 'wx', mode: 0o644 });
      if (stage) await this.git.run(['add', '--', `:(literal)${path}`], options);
    }
    return paths;
  }

  /**
   * Copies the agent folder's first file into the Working copy and commits it: what a careless
   * agent could do, so the worker's check before the push has something to stop. Returns its path.
   */
  private async copyAgentFile(workspace: RunWorkspace, signal: AbortSignal): Promise<string> {
    const dir = workspace.agentFolder;
    if (!dir) throw new AgentFailedError('The fake agent has no agent folder to copy from.');
    const names: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(join(dir, relative), { withFileTypes: true })) {
        const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) names.push(path);
      }
    };
    await walk('');
    const source = names.sort()[0];
    if (source === undefined) throw new AgentFailedError('The agent folder holds no file.');
    const target = `copied-${source.replaceAll('/', '-')}`;
    await this.write(workspace, target, await readFile(join(dir, source)));
    const options = { cwd: workspace.repoDir, timeoutMs: GIT_TIMEOUTS.local, signal };
    await this.git.run(['add', '--', `:(literal)${target}`], options);
    await this.git.run(['commit', '--quiet', '--no-verify', '-m', 'Fake copy of an agent file'], {
      ...options,
      config: this.commitConfig,
    });
    return target;
  }

  /** Writes the fake change into the Working copy and, if asked, commits it on the Run branch. */
  private async change(workspace: RunWorkspace, signal: AbortSignal, commit: boolean) {
    await this.write(workspace, FAKE_CHANGE_FILE, 'Made by the fake runner.\n');
    if (!commit) return;
    const options = { cwd: workspace.repoDir, timeoutMs: GIT_TIMEOUTS.local, signal };
    await this.git.run(['add', '--', FAKE_CHANGE_FILE], options);
    await this.git.run(['commit', '--quiet', '--no-verify', '-m', 'Fake change'], {
      ...options,
      config: this.commitConfig,
    });
  }

  /**
   * Writes a new file at the top of the Working copy. Repository content is untrusted: whatever
   * is at that path (e.g. a symlink to a file outside the Working copy) is removed, never
   * written through, and the file is created exclusively.
   */
  private async write(workspace: RunWorkspace, name: string, content: string | Buffer) {
    const file = join(workspace.repoDir, name);
    await rm(file, { force: true });
    await writeFile(file, content, { flag: 'wx', mode: 0o644 });
  }

  /** Writes {@link FAKE_FOLLOW_UP_FILE}, new content per Run step, and commits it if asked. */
  private async followUpChange(
    workspace: RunWorkspace,
    signal: AbortSignal,
    completedSteps: number,
    commit: boolean,
  ) {
    const file = join(workspace.repoDir, FAKE_FOLLOW_UP_FILE);
    // As in `change`: never written through whatever the repository put at that path.
    await rm(file, { force: true });
    await writeFile(file, `Follow-up change after run step ${completedSteps}.\n`, {
      flag: 'wx',
      mode: 0o644,
    });
    if (!commit) return;
    const options = { cwd: workspace.repoDir, timeoutMs: GIT_TIMEOUTS.local, signal };
    await this.git.run(['add', '--', FAKE_FOLLOW_UP_FILE], options);
    await this.git.run(['commit', '--quiet', '--no-verify', '-m', 'Fake follow-up change'], {
      ...options,
      config: this.commitConfig,
    });
  }

  private async *resumeStep({
    run,
    workspace,
    signal,
    answer,
    sessionRef,
    reason,
  }: ResumeRunStepInput): RunStep {
    const scenario = fakeScenarioOf(run.task);
    yield {
      type: 'message',
      text: reason === 'follow_up' ? 'fake runner: follow-up' : 'fake runner: resume',
    };
    const agentLine = fakeAgentLine(run);
    if (agentLine !== null) yield { type: 'message', text: agentLine };
    for (const text of fakePhaseLines(run)) yield { type: 'message', text };
    const folderLine = await fakeAgentFolderLine(workspace.agentFolder);
    if (folderLine !== null) yield { type: 'message', text: folderLine };
    const skillsLine = fakeSkillsLine(workspace.skills);
    if (skillsLine !== null) yield { type: 'message', text: skillsLine };
    signal.throwIfAborted();
    if (
      scenario === 'lost-session' ||
      sessionRef !== fakeSessionRef(run.runId, run.phase?.position)
    ) {
      throw new AgentFailedError(
        'The fake agent cannot resume: the provider has no such session (its transcript is missing).',
      );
    }
    if (answer.trim() === '') throw new AgentFailedError('The fake agent got no answer.');
    if (run.phase?.kind === 'review' && reason === 'answer') {
      yield { type: 'output', text: `answer received: ${answer}` };
      return { outcome: 'done', summary: 'The fake review approved it.', verdict: 'approved' };
    }
    if (reason === 'bring_up_to_date') {
      // The instruction carries the operator's note; the note names the scenario.
      const updateScenario = fakeScenarioOf(answer);
      yield { type: 'output', text: `bring-up received: ${updateScenario}` };
      if (updateScenario === 'resolve-conflicts' || updateScenario === 'resolve-in-tree') {
        for (const path of await this.resolveConflicts(
          workspace,
          signal,
          updateScenario === 'resolve-conflicts',
        )) {
          yield { type: 'output', text: `resolved ${path}` };
        }
        return done();
      }
      return yield* this.play(updateScenario, run, workspace, signal, true);
    }
    if (reason === 'follow_up') {
      // A Follow-up names its own scenario (`[fake:<scenario>]` in its text).
      const followUpScenario = fakeScenarioOf(answer);
      yield { type: 'output', text: `follow-up received: ${followUpScenario}` };
      return yield* this.play(followUpScenario, run, workspace, signal, true);
    }
    yield { type: 'output', text: `answer received: ${answer}` };
    // The first resume of question-twice (its second Run step) asks again.
    if (scenario === 'question-twice' && run.completedSteps === 1) {
      return asking(run.runId, 'And which variant of it?', run.phase?.position);
    }
    return done();
  }
}

/** The result with the fake agent's session reference. */
function withSession(run: StartRunStepInput['run'], result: RunStepResult): RunStepResult {
  const sessionRef = fakeSessionRef(run.runId, run.phase?.position);
  // A Phase's result says which Phase it is, so the next Phase can be seen to be told it.
  return run.phase !== undefined && result.outcome === 'done'
    ? { ...result, summary: `${result.summary} (Phase ${run.phase.itemId})`, sessionRef }
    : { ...result, sessionRef };
}

function done(): RunStepResult {
  return {
    outcome: 'done',
    summary: 'The fake agent finished the task.',
    pullRequest: { title: 'Fake change', body: 'Made by the fake runner.' },
    checks: [{ name: 'fake check', result: 'passed' }],
  };
}
