#!/usr/bin/env node
// Real-CLI smoke of the model option, NOT PART OF CI: run it as the agent user after the managed
// guardrails are installed. Usage: CLAUDE_CODE_ENABLED=true node smoke-claude-model.mjs [alias]
// Procedure and checks: docs/architecture/agent-worker.md (Model probes).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { BASE_RULES } from '@agentic-studio/contracts';
import { PROVIDER_MODELS } from '@agentic-studio/agent-definitions';
import { AGENT_RESULT_JSON_SCHEMA } from '../dist/agent-definition/index.js';
import {
  claudeArguments,
  claudeEnvironment,
  claudePrompt,
  claudeStepFiles,
} from '../dist/claude-code/cli-options.js';
import { prepareRunSettings } from '../dist/claude-code/guardrails.js';
import { probeClaudeCode } from '../dist/claude-code/runner.js';
import { ClaudeStream } from '../dist/claude-code/stream.js';
import { DEFAULT_PROVIDER_BINARIES } from '../dist/config.js';
import { ManagedGuardrails } from '../dist/managed-guardrails.js';
import { ProviderGate, readProviderSwitches } from '../dist/provider-gate.js';
import { composeProjectName } from '../dist/run-layout.js';
import { modelsOfLine } from './smoke-model-events.mjs';

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const keep = process.argv.includes('--keep');
const alias = process.argv.slice(2).find((argument) => !argument.startsWith('--')) ?? 'haiku';
const line = (text) => process.stdout.write(`${text}\n`);

if (process.platform !== 'linux') {
  line('smoke: Linux only (run it in WSL as the agent user).');
  process.exit(1);
}
if (alias === 'default' || !PROVIDER_MODELS.claude_code.includes(alias)) {
  line(`smoke: ${JSON.stringify(alias)} is not a non-default Claude Code model of the list.`);
  process.exit(1);
}
const switches = readProviderSwitches(process.env);
if (!switches.claude_code) {
  line('smoke: CLAUDE_CODE_ENABLED is not exactly "true"; nothing was started.');
  process.exit(1);
}
const cli = {
  gate: new ProviderGate(switches),
  binaries: { ...DEFAULT_PROVIDER_BINARIES, claude_code: process.env.CLAUDE_CODE_BIN || 'claude' },
};
const version = await probeClaudeCode(cli, process.env);
line(
  `version check: ${version.ok ? `${version.version} (supported)` : `FAILED: ${version.reason}`}`,
);
if (!version.ok) process.exit(1);
const managed = await new ManagedGuardrails().problem('claude_code');
line(`managed guardrails: ${managed === null ? 'in place' : `FAILED: ${managed}`}`);
if (managed !== null) process.exit(1);

const root = mkdtempSync(join(tmpdir(), 'studio-claude-model-smoke-'));
const runDir = join(root, 'run');
const repoDir = join(runDir, 'repo');
mkdirSync(repoDir, { recursive: true });
writeFileSync(join(repoDir, 'README.md'), '# Model smoke\n');
const files = claudeStepFiles(runDir);
mkdirSync(files.tmpDir, { recursive: true });
writeFileSync(files.instructionsFile, BASE_RULES.text);
const guardrails = await prepareRunSettings(files.settingsFile);

/** One CLI start with the runner's own argument builder and the model option. */
async function step(label, prompt, sessionRef) {
  const args = claudeArguments({
    prompt,
    allowedTools: guardrails.allowedTools,
    settingsFile: guardrails.settingsFile,
    instructionsFile: files.instructionsFile,
    maxTurns: 5,
    jsonSchema: AGENT_RESULT_JSON_SCHEMA,
    model: alias,
    ...(sessionRef === undefined ? {} : { sessionRef }),
  });
  const env = claudeEnvironment({
    base: process.env,
    tmpDir: files.tmpDir,
    composeProjectName: composeProjectName(RUN_ID),
  });
  const child = spawn(cli.binaries.claude_code, args, {
    cwd: repoDir,
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10 * 60_000,
  });
  const exited = new Promise((resolve) => child.once('close', resolve));
  const stream = new ClaudeStream();
  const models = new Set();
  for await (const text of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    for (const model of modelsOfLine(text)) models.add(model);
    stream.accept(text);
  }
  const code = await exited;
  const outcome = stream.finish({ exitCode: code, spawnFailed: false });
  const result = 'result' in outcome ? outcome.result : undefined;
  line(
    `${label}: exit code ${code}, outcome=${result?.outcome ?? 'none'}, ` +
      `models reported: ${models.size}`,
  );
  return { models, sessionRef: result?.sessionRef };
}

let failures = 0;
const check = (label, ok) => {
  if (!ok) failures += 1;
  line(`  ${label}: ${ok ? 'yes' : 'NO'}`);
};
const names = (models) => [...models].every((model) => model.toLowerCase().includes(alias));
const same = (a, b) => a.size === b.size && [...a].every((model) => b.has(model));

try {
  const first = await step(
    `step 1 (--model ${alias})`,
    claudePrompt('task', 'Change nothing. End the step as done with the summary "ok".'),
  );
  check('the first step reported a model', first.models.size > 0);
  check(`every reported model is the ${alias} alias's`, names(first.models));
  check('a session to resume was reported', first.sessionRef !== undefined);
  if (first.sessionRef !== undefined) {
    const second = await step(
      `step 2 (resumed, --model ${alias})`,
      claudePrompt('answer', 'Change nothing. End the step as done with the summary "ok again".'),
      first.sessionRef,
    );
    check('the resumed step reported a model', second.models.size > 0);
    check(`the resumed session ran on the ${alias} alias`, names(second.models));
    check(
      'the resumed step reports the same models as the first',
      same(first.models, second.models),
    );
  }
} catch (error) {
  failures += 1;
  line(`smoke: FAILED (${error?.name ?? 'Error'}: ${error?.message ?? error})`);
} finally {
  if (!keep) rmSync(root, { recursive: true, force: true });
}
line(failures === 0 ? 'smoke: PASS' : 'smoke: FAIL');
process.exit(failures === 0 ? 0 : 1);
