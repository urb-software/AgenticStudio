---
name: studio-refactor-finder
description: Periodic audit of one area (api, web, agent-worker, packages, or all) against the written architecture rules and well-known practice. Runs the gates and a drift scan, reads the code through fixed lenses, and reports weighted observations: what was noticed, how much each matters and why. The operator decides what, if anything, becomes work. Use when the operator asks to find refactors, audit the architecture, check that constraints still hold, or "keep the code in good form".
disable-model-invocation: true
---

# Refactor finder

A read-only audit. It answers three questions about one area of the repository:

1. Do the written rules still hold, including the ones no gate checks?
2. Where is a rule kept by the letter and broken in intent?
3. Where is there no rule yet, and the code has started to disagree with itself?

It ends in a report of weighted observations. **Nothing follows from the report automatically:** the audit never changes code, documents or gates, and never creates tickets. What becomes work is the operator's decision, finding by finding.

`/studio-improve-codebase-architecture` looks for modules worth deepening and explores freely. This skill checks conformance and drift against rules, with numbers that can be compared between runs. Run this one first; its hot spots are good input for the other.

Paths are relative to the repository root.

## 1. Pick the area and read its rules

The argument is `api`, `web`, `agent-worker`, `packages` or `all`. With no argument, use `all`.

| Area | Rules | Gate | State of the rules |
| --- | --- | --- | --- |
| `api` | `docs/architecture/backend.md` §2–§3, ADR 0003, `docs/engineering/quality.md` §4–§5 | `pnpm architecture:api` | Written and largely enforced |
| `web` | `docs/architecture/frontend.md`, `quality.md` §4 | `pnpm architecture:web` | Boundaries written; internal form of a feature mostly unwritten |
| `agent-worker` | `docs/architecture/agent-worker.md`, ADR 0002, `docs/engineering/security.md` | none of its own | Behaviour and trust written; internal structure unwritten |
| `packages` | `docs/architecture/system.md`, `quality.md` §4 | `pnpm architecture:monorepo` | Ownership written |
| every area | `AGENTS.md`, `docs/architecture/glossary.md`, rule 14 (comments) | `pnpm architecture:monorepo` | |

Read the documents of the area before reading code. Decisions recorded there or in an ADR are settled: do not report them as findings (step 5, "Reopen").

Where the rules are unwritten, the audit's product is different: not a list of violations but **a proposed set of rules** drawn from what the code already does most of the time, with the places that disagree. That is how the API got its rules.

## 2. Run what is already enforced

```bash
pnpm architecture:api        # about two minutes
pnpm architecture:web
pnpm architecture:monorepo
pnpm structure:report        # API only: sizes, methods per repository, comment ratio
```

A failing gate is not a refactor finding. Report it first, as a broken build, and continue.

## 3. Run the drift scan

```bash
node .claude/skills/studio-refactor-finder/scan.mjs --area api
node .claude/skills/studio-refactor-finder/scan.mjs --area all --top 10
node .claude/skills/studio-refactor-finder/scan.mjs --area api --base-ref HEAD~60
node .claude/skills/studio-refactor-finder/scan.mjs --area all --json
```

It takes a few seconds, changes nothing and always exits 0 (2 for an unknown area). It prints, per area: the largest files; files with several classes or many exports; long functions; wide constructors; functions with many parameters; public static methods that do not build their class; classes with no instance member; one concept with several names for the same role; the same list of values declared twice; exports no other production file names; markers that switch a tool off; and the most changed files weighted by size.

`--base-ref <git ref>` adds the change of every count against that commit. Use the commit of the previous audit if the operator names it; otherwise the commit from about a month ago:

```bash
git rev-list -1 --before="30 days ago" dev
```

If that prints nothing, the repository is younger than that: pick a commit with `git log --oneline`.

**The scan notices; it does not judge.** A function over 40 lines, a file with many exports or a wide constructor is an observation with no decision attached: many are fine as they are. The thresholds only choose what gets listed. An observation becomes a finding when the code is read and it turns out to cost something, and even then its weight (step 6) decides how much it matters. It classifies by signature and by text search, so open the file and confirm before reporting anything. Known noise:

- Functions over 40 lines in `web` are mostly React components: the signal there is a component that fetches, holds state and renders at once, not its length.
- A list of values declared in the API's domain and again in `packages/contracts` may be deliberate (the domain does not import the worker protocol). It is a finding only if no test or type ties the two together.
- "Exports no other production file names" misses re-exports under another name and anything reached through a framework convention.
- Nest module classes and their `register` / `forRoot` are skipped on purpose.

To add an area (a new app or package), add one line to `AREAS` at the top of `scan.mjs`.

## 4. Read the code through the lenses

The scan cannot see where logic lives or whether a rule is kept in intent. Read [LENSES.md](LENSES.md) and apply it:

- Start from the hot spots of step 3 (most changed, largest), then one feature or folder of each kind, read whole.
- For `all`, use one read-only sub-agent per area, started together, each given: the area's documents from step 1, its scan output, the lenses that apply, and the finding format of step 5. They report; they do not edit.
- Stop reading a kind of file once two examples agree. The audit samples; it does not review every file.

## 5. Classify every finding

| Kind | Meaning | What it could lead to |
| --- | --- | --- |
| **Violation** | A written rule is broken and the gate did not notice | Fix, and a gate check so it cannot return |
| **Escape route** | The letter of a rule holds, its intent does not (the code moved instead of changing) | Fix, a sharper wording of the rule, and a check for the route |
| **Unenforced rule** | A written rule that only review protects, and it has started to slip | A gate check, or a number in the structure report |
| **Missing rule** | The code does the same thing in two or more ways and no rule says which | A proposed rule: the operator decides |
| **Reopen** | A settled decision that now causes real, shown friction | One explicit question to the operator. Rare |

Each finding states:

- **What**, in one sentence, in the glossary's words.
- **Evidence**: `path:line` for two or three examples and the total count. No evidence, no finding.
- **Rule**: the document and section it breaks, or "none".
- **Practice**: the well-known practice behind it, named (for example: aggregates refer to each other by id; a value object validates on creation; server state has one owner; dependency direction points inward). Do not name other products.
- **Fix**: what would change, in two or three lines. No code.
- **Guardrail**: the general check that would have caught it, stated by path pattern and never by a module's real name. If none is possible, say what makes drift visible instead (a count in the report, a line in the review brief).
- **Weight**: the five factors of step 6 with their scores.

Then ask of every finding: **once this is fixed, where does the same thing reappear one level down?** A function removed from the domain came back as a static method, then as an unexported helper. Name the next hiding place and close it in the same finding.

Leave out: what a gate or the linter already enforces and passes; taste; anything a document settles.

## 6. Weigh every finding

No single factor decides. Score each finding on five factors and add them up:

| Factor | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| **Rule** | No rule; a number from the scan only | The code does one thing in several ways, no rule says which | The letter of a written rule holds, its intent does not | A written rule is broken |
| **Harm** | Appearance only | Harder to read or change | Can cause a wrong result, or two places can disagree | Security-relevant code (addresses, redaction, secrets, the spawn boundary) or a public contract |
| **Change** | Not touched in 90 days | Touched now and then | Touched in most recent work | A top hot spot of the scan |
| **Spread** | One place | A few places | Many places | Many places and more than at the base commit |
| **Cost** (subtracted) | Small, one pull request | Medium | Large, or wide across files | Large and in security-relevant code |

Weight = Rule + Harm + Change + Spread − Cost, from −3 to 12.

| Weight | Band | Meaning |
| --- | --- | --- |
| 8 or more | **Recommended** | The audit would do it |
| 5 to 7 | **Worth considering** | A real cost, not urgent; a good candidate when work touches that code anyway |
| 4 or less | **Noted** | Recorded so the next audit can see whether it grows. No action proposed |

Two fixed points: a broken rule in security-relevant code is always **Recommended**, and an observation that scores 0 on both Rule and Harm is always **Noted**, however large the number behind it. A long function nobody changes, in code no rule covers, is noted and nothing more.

The band is the audit's opinion. It decides the order of the report and nothing else.

## 7. Report

In the conversation, as Markdown. Nothing is written to the repository.

1. **Verdict**, three lines: gates, trend against the base, and whether the area needs work now or can be left.
2. **Trend**: the count table of the scan with its changes.
3. **Findings by weight**, highest first, as one table (finding, kind, the five scores, weight, band), then the detail of each **Recommended** and **Worth considering** finding in the format of step 5. At most ten in detail.
4. **Noted**: one line each, with the number behind it. No fix proposed.
5. **The audit's opinion**: which findings it would do and in what order, and which it would leave. Say plainly when the right advice is to do nothing and build features: every round of this has a smaller return than the one before.

Then stop. The report is the end of the audit.

## 8. After the report: the operator decides

Do not create tickets, do not call `/studio-to-tickets` and do not start a grilling round unless the operator asks. The operator may accept a finding, change its weight (they know what is planned for that code and what is not), ask for more evidence, or drop it. Every answer is valid, including "none of these".

If the operator disagrees with a score, take their value and re-rank: the weights exist to make the reasoning visible, not to win the argument.

When the operator asks to go further with named findings:

- Questions that are theirs (adopting a new rule, reopening a settled decision, the parent Epic) are asked in the format of `/studio-grilling`, with a recommended answer each. Facts and technical choices stay the audit's job.
- Tickets are drafted through `/studio-to-tickets`, which has its own approval step before anything is published.

For every ticket drafted that way:

- The rule text, the code change and the gate check land together. A check is never added in a failing state and always has a failing fixture (`quality.md` §5).
- A wide mechanical change is split so each step stays green: tests first, then production code.
- "Do not change" lists what must stay byte-for-byte: behaviour, the HTTP contract, the worker protocol, the database schema.
- Security-relevant tests are named as not to be weakened.

Never set `Workflow Stage` to Ready, never weaken or remove a gate to make a finding go away, and never fix a finding during the audit.

## Changing the weights

The factors, their scales and the two band limits in step 6 are this repository's current judgement, not a standard. If audits keep recommending things the operator declines, or keep noting things that later hurt, change the table here in a reviewed pull request and say what prompted it.
