// Measures what Claude Code sessions for this repository cost in tokens and turns, per agent role.
// Reads the session transcripts Claude Code keeps on the operator's machine; it calls no service.
//
//   node scripts/agent-usage.mjs <transcript-dir> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//
// <transcript-dir> is the project's folder under ~/.claude/projects/. The date filters apply to the
// first timestamp of each transcript, so a baseline and a later period can be compared.
// Results and how to read them: docs/engineering/agent-usage-baseline.md.

import { createReadStream, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';

// List prices in USD per million tokens, as of 2026-11-03. Cache writes cost 1.25x input for the
// 5-minute lifetime and 2x for the 1-hour lifetime.
const PRICES = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
};

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--'));
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const since = option('--since');
const until = option('--until');
if (!root) {
  console.error(
    'usage: node scripts/agent-usage.mjs <transcript-dir> [--since YYYY-MM-DD] [--until YYYY-MM-DD]',
  );
  process.exit(1);
}

function transcripts(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) transcripts(path, found);
    else if (path.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

function roleOf(isSubagent, firstPrompt) {
  if (!isSubagent) return 'coordinator (main session)';
  const start = firstPrompt.slice(0, 400).toLowerCase();
  if (/implementer/.test(start.slice(0, 200))) return 'implementer';
  if (/independent review/.test(start)) return 'independent reviewer';
  if (/review/.test(start)) return 'review sub-agent';
  return 'other sub-agent';
}

function shellKind(command) {
  const c = command.trim().replace(/^cd\s+\S+\s*(&&|;)\s*/, '');
  if (/^(sleep|timeout)\b/.test(c)) return 'sleep / wait';
  if (/^gh\s+(run|pr checks)/.test(c)) return 'CI status';
  if (/^gh\b/.test(c)) return 'gh (other)';
  if (/^git\b/.test(c)) return 'git';
  if (/(vitest|playwright|pnpm\s+(-\S+\s+)*(run\s+)?test|jest)/.test(c)) return 'test';
  if (/(tsc|typecheck|eslint|lint|prettier|format|check:|architecture:)/.test(c))
    return 'lint / typecheck / format / architecture';
  if (/^(cat|head|tail|sed|awk|wc)\b/.test(c)) return 'read file via shell';
  if (/^(grep|rg|find|ls|tree)\b/.test(c)) return 'search / list via shell';
  return 'other';
}

const emptyTotals = () => ({
  agents: 0,
  turns: 0,
  singleToolTurns: 0,
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
  usd: 0,
  unpricedTurns: 0,
  turnsPerAgent: [],
  shell: {},
  models: {},
});

async function read(file) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const turns = new Map();
  let firstPrompt = '';
  let firstTimestamp;
  for await (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    firstTimestamp ??= entry.timestamp;
    const message = entry.message;
    if (!message) continue;
    if (entry.type === 'user' && !firstPrompt) {
      firstPrompt =
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? [])
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join(' ');
    }
    // One model response is one turn. A response is logged once per content block, so key by id.
    if (entry.type === 'assistant' && message.id && message.usage) {
      const tools = (message.content ?? []).filter((block) => block.type === 'tool_use');
      const turn = turns.get(message.id) ?? { tools: [] };
      turn.usage = message.usage;
      turn.model = message.model;
      turn.tools.push(...tools);
      turns.set(message.id, turn);
    }
  }
  return { turns, firstPrompt, firstTimestamp };
}

const byRole = {};
let earliest;
let latest;

for (const file of transcripts(root)) {
  const { turns, firstPrompt, firstTimestamp } = await read(file);
  const day = firstTimestamp?.slice(0, 10);
  if (!day || turns.size === 0) continue;
  if ((since && day < since) || (until && day > until)) continue;
  if (!earliest || day < earliest) earliest = day;
  if (!latest || day > latest) latest = day;

  const role = roleOf(relative(root, file).split(sep).length > 1, firstPrompt);
  const totals = (byRole[role] ??= emptyTotals());
  totals.agents += 1;
  totals.turnsPerAgent.push(turns.size);

  for (const { usage, model, tools } of turns.values()) {
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const write5m = Math.max(0, (usage.cache_creation_input_tokens ?? 0) - write1h);
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    totals.turns += 1;
    if (tools.length === 1) totals.singleToolTurns += 1;
    totals.input += input;
    totals.cacheWrite5m += write5m;
    totals.cacheWrite1h += write1h;
    totals.cacheRead += cacheRead;
    totals.output += output;
    totals.models[model] = (totals.models[model] ?? 0) + 1;
    const price = PRICES[model];
    if (price) {
      totals.usd +=
        (input * price.input +
          write5m * price.input * 1.25 +
          write1h * price.input * 2 +
          cacheRead * price.cacheRead +
          output * price.output) /
        1e6;
    } else if (input + write5m + write1h + cacheRead + output > 0) {
      totals.unpricedTurns += 1;
    }
    for (const tool of tools) {
      if (tool.name !== 'Bash' && tool.name !== 'PowerShell') continue;
      const kind = shellKind(tool.input?.command ?? '');
      totals.shell[kind] = (totals.shell[kind] ?? 0) + 1;
    }
  }
}

const millions = (n) => (n / 1e6).toFixed(1);
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
};
const roles = Object.entries(byRole).sort((a, b) => b[1].usd - a[1].usd);
const totalUsd = roles.reduce((sum, [, t]) => sum + t.usd, 0);

console.log(`Transcripts started ${earliest} to ${latest}\n`);
console.log(
  '| Role | Agents | Turns | Turns per agent (mean / median / p90) | Context per turn | One-tool turns | Cache read (M) | Cache write 5m / 1h (M) | Output (M) | List price (USD) | Share |',
);
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [role, t] of roles) {
  const context = (t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead) / t.turns / 1000;
  console.log(
    `| ${role} | ${t.agents} | ${t.turns} | ${(t.turns / t.agents).toFixed(0)} / ${percentile(t.turnsPerAgent, 50)} / ${percentile(t.turnsPerAgent, 90)} | ${context.toFixed(0)}k | ${((t.singleToolTurns / t.turns) * 100).toFixed(0)}% | ${millions(t.cacheRead)} | ${millions(t.cacheWrite5m)} / ${millions(t.cacheWrite1h)} | ${millions(t.output)} | ${t.usd.toFixed(0)} | ${((t.usd / totalUsd) * 100).toFixed(0)}% |`,
  );
}
console.log(`\nTotal at list price: USD ${totalUsd.toFixed(0)}`);

for (const [role, t] of roles) {
  const models = Object.entries(t.models)
    .map(([model, count]) => `${model} ${count}`)
    .join(', ');
  console.log(
    `\n${role}: models by turns: ${models}; USD per agent ${(t.usd / t.agents).toFixed(1)}; turns without a known price: ${t.unpricedTurns}`,
  );
}

const implementer = byRole.implementer;
if (implementer) {
  console.log('\nImplementer shell calls per agent\n');
  console.log('| Kind | Calls per agent |');
  console.log('| --- | --- |');
  for (const [kind, count] of Object.entries(implementer.shell).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${kind} | ${(count / implementer.agents).toFixed(1)} |`);
  }
}
