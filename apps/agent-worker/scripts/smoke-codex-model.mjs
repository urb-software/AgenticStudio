#!/usr/bin/env node
// Real-CLI smoke of `--model` and of `--model` before `resume`, NOT PART OF CI: run it as the agent
// user after the managed guardrails are installed. Usage: CODEX_CLI_ENABLED=true node
// smoke-codex-model.mjs [model]. Procedure and checks: docs/architecture/agent-worker.md.
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BASE_RULES } from '@agentic-studio/contracts';
import { PROVIDER_MODELS } from '@agentic-studio/agent-definitions';
import {
  codexAnswer,
  codexEnvironment,
  codexPrompt,
  codexResumeArguments,
  codexStartArguments,
  codexStepFiles,
} from '../dist/codex/cli-options.js';
import { prepareCodexHome } from '../dist/codex/codex-home.js';
import { CODEX_RESULT_JSON_SCHEMA } from '../dist/codex/result-schema.js';
import { probeCodex } from '../dist/codex/runner.js';
import { CodexStream } from '../dist/codex/stream.js';
import { DEFAULT_PROVIDER_BINARIES } from '../dist/config.js';
import { GitRunner } from '../dist/git.js';
import { ManagedGuardrails } from '../dist/managed-guardrails.js';
import { ProviderGate, readProviderSwitches } from '../dist/provider-gate.js';
import { composeProjectName } from '../dist/run-layout.js';
import { modelsOfLine } from './smoke-model-events.mjs';

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const keep = process.argv.includes('--keep');
const model = process.argv.slice(2).find((argument) => !argument.startsWith('--')) ?? 'gpt-6-luna';
const line = (text) => process.stdout.write(`${text}\n`);

if (process.platform !== 'linux') {
  line('smoke: Linux only (run it in WSL as the agent user).');
  process.exit(1);
}
if (model === 'default' || !PROVIDER_MODELS.codex.includes(model)) {
  line(`smoke: ${JSON.stringify(model)} is not a non-default Codex model of the list.`);
  process.exit(1);
}
const switches = readProviderSwitches(process.env);
if (!switches.codex) {
  line('smoke: CODEX_CLI_ENABLED is not exactly "true"; nothing was started.');
  process.exit(1);
}
const cli = {
  gate: new ProviderGate(switches),
  binaries: { ...DEFAULT_PROVIDER_BINARIES, codex: process.env.CODEX_CLI_BIN || 'codex' },
};
const version = await probeCodex(cli, process.env);
line(
  `install and version check: ${version.ok ? `${version.version} (supported)` : `FAILED: ${version.reason}`}`,
);
if (!version.ok) process.exit(1);
const managed = await new ManagedGuardrails().problem('codex');
line(`managed guardrails: ${managed === null ? 'in place' : `FAILED: ${managed}`}`);
if (managed !== null) process.exit(1);

const root = mkdtempSync(join(tmpdir(), 'studio-codex-model-smoke-'));
const runDir = join(root, 'run');
const repoDir = join(runDir, 'repo');
mkdirSync(repoDir, { recursive: true });
const git = new GitRunner();
const local = { cwd: repoDir, timeoutMs: 60_000 };
await git.run(['init', '--quiet', '--initial-branch=main'], local);
writeFileSync(join(repoDir, 'README.md'), '# Model smoke\n');
await git.run(['add', '--all'], local);
await git.run(
  [
    '-c',
    'user.name=Studio Smoke',
    '-c',
    'user.email=smoke@example.test',
    'commit',
    '--quiet',
    '-m',
    'Initial commit',
  ],
  local,
);
const home = process.env.HOME ?? '';
await prepareCodexHome({ home, dataDir: root }, [repoDir]);
const files = codexStepFiles(runDir);
mkdirSync(files.dir, { recursive: true });
mkdirSync(files.tmpDir, { recursive: true });
writeFileSync(files.schemaFile, CODEX_RESULT_JSON_SCHEMA);

/** The agent user's Codex session file of `sessionRef`, if there is one. */
function sessionFile(sessionRef) {
  const walk = (dir) =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? walk(join(dir, entry.name))
            : entry.name.includes(sessionRef) && entry.name.endsWith('.jsonl')
              ? [join(dir, entry.name)]
              : [],
        )
      : [];
  return walk(join(home, '.codex', 'sessions'))[0];
}
const linesOf = (path) => (path ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []);

/** One CLI start with the runner's own argument builders and the model option. */
async function step(label, stdinText, sessionRef) {
  const input = { workingCopy: repoDir, sandbox: 'workspace-write', files, model };
  const resumed = sessionRef !== undefined;
  const args = resumed
    ? codexResumeArguments({ ...input, sessionRef })
    : codexStartArguments(input);
  const stdinFile = resumed ? files.answerFile : files.promptFile;
  writeFileSync(stdinFile, stdinText);
  rmSync(files.resultFile, { force: true });
  const env = codexEnvironment({
    base: process.env,
    tmpDir: files.tmpDir,
    composeProjectName: composeProjectName(RUN_ID),
  });
  const stdin = openSync(stdinFile, 'r');
  let child;
  try {
    child = spawn(cli.binaries.codex, args, {
      cwd: repoDir,
      env,
      stdio: [stdin, 'pipe', 'ignore'],
      timeout: 10 * 60_000,
    });
  } finally {
    closeSync(stdin);
  }
  const exited = new Promise((resolve) => child.once('close', resolve));
  const stream = new CodexStream(sessionRef);
  const models = new Set();
  for await (const text of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    for (const found of modelsOfLine(text)) models.add(found);
    stream.accept(text);
  }
  const code = await exited;
  const outcome = stream.finish(
    { exitCode: code, spawnFailed: false },
    resumed
      ? { kind: 'last-message' }
      : {
          kind: 'file',
          text: existsSync(files.resultFile) ? readFileSync(files.resultFile, 'utf8') : undefined,
        },
  );
  const result = 'result' in outcome ? outcome.result : undefined;
  line(
    `${label}: exit code ${code}, outcome=${result?.outcome ?? 'none'}, ` +
      `models in the stream: ${models.size}`,
  );
  return { models, sessionRef: stream.sessionRef };
}

let failures = 0;
let inconclusive = false;
const check = (label, ok) => {
  if (!ok) failures += 1;
  line(`  ${label}: ${ok ? 'yes' : 'NO'}`);
};
const only = (models) => models.size > 0 && [...models].every((found) => found === model);

try {
  const first = await step(
    `step 1 (--model ${model})`,
    codexPrompt(BASE_RULES.text, 'Change nothing. End the step as done with the summary "ok".'),
  );
  check('a session to resume was reported', first.sessionRef !== undefined);
  if (first.sessionRef !== undefined) {
    const before = linesOf(sessionFile(first.sessionRef)).length;
    const second = await step(
      `step 2 (resumed, --model ${model} before resume)`,
      codexAnswer('Change nothing. End the step as done with the summary "ok again".'),
      first.sessionRef,
    );
    check(
      'the resumed step started (the CLI accepted --model before resume)',
      second.sessionRef === first.sessionRef,
    );
    let reported = second.models;
    let where = 'the event stream';
    if (reported.size === 0) {
      // The stream names no model: read what the resumed turn added to the session file.
      reported = new Set(
        linesOf(sessionFile(first.sessionRef))
          .slice(before)
          .flatMap((text) => [...modelsOfLine(text)]),
      );
      where = 'the session file';
    }
    if (reported.size === 0) {
      inconclusive = true;
      line(
        '  the resumed session reports no model in the stream or the session file: INCONCLUSIVE',
      );
    } else {
      line(`  the model is reported by ${where}: yes`);
      check(`the resumed session ran on ${model}, and on no other model`, only(reported));
    }
  }
} catch (error) {
  failures += 1;
  line(`smoke: FAILED (${error?.name ?? 'Error'}: ${error?.message ?? error})`);
} finally {
  if (!keep) rmSync(root, { recursive: true, force: true });
}
if (failures > 0) line('smoke: FAIL');
else line(inconclusive ? 'smoke: INCONCLUSIVE' : 'smoke: PASS');
process.exit(failures > 0 ? 1 : inconclusive ? 2 : 0);
