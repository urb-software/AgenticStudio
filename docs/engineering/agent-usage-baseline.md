# Agent Usage Baseline

**Status:** measurement record, not policy. It fixes the numbers from before the skill and model changes of 2026-11-16 so later periods can be compared with them.

## 1. What was measured

- **Source:** the Claude Code session transcripts for this repository on the operator's machine, read by `scripts/agent-usage.mjs`.
- **Period:** transcripts started 2026-11-09 to 2026-11-16 (209 transcripts; the measuring session itself is included in the coordinator row).
- **Configuration in that period:** every role ran on Claude Opus 5.5, apart from a few coordinator turns. Skills were as on `dev` at `790ab01`, before the "Working economically" rules, the **Read first** / **Verify command** handoff fields and the delta re-review step existed.
- **Turn:** one model response. Each turn re-reads the whole conversation so far, so a session costs roughly its turns times its context size.
- **List price:** USD per million tokens as of 2026-11-03 (Claude Opus 5.5: input 4, output 20, cache read 0.20; cache write 1.25x input for the 5-minute lifetime, 2x for the 1-hour lifetime). On a subscription this is usage against limits, not an invoice; the figure is there so periods on different models stay comparable.

## 2. Baseline by role

| Role | Agents | Turns | Turns per agent (mean / median / p90) | Context per turn | One-tool turns | Cache read (M) | Cache write 5m / 1h (M) | Output (M) | List price (USD) | Share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| implementer | 54 | 8030 | 149 / 132 / 275 | 281k | 87% | 2220.3 | 37.5 / 0.0 | 6.8 | 768 | 60% |
| independent reviewer | 43 | 1928 | 45 / 34 / 58 | 177k | 93% | 316.3 | 25.6 / 0.0 | 1.8 | 227 | 18% |
| coordinator (main session) | 14 | 1905 | 136 / 28 / 148 | 228k | 53% | 425.9 | 0.0 / 9.3 | 1.7 | 226 | 18% |
| review sub-agent | 97 | 947 | 10 / 9 / 15 | 69k | 93% | 59.3 | 5.8 / 0.0 | 0.6 | 54 | 4% |
| other sub-agent | 2 | 23 | 12 / 13 / 13 | 78k | 52% | 1.6 | 0.2 / 0.0 | 0.0 | 3 | 0% |

Total at list price: **USD 1277**.

Per agent at list price: implementer 14.2, independent reviewer 5.3, review sub-agent 0.6.

The largest implementer sessions were several times the mean: #104 at 495 turns and #100 at 460.

## 3. Where implementer turns went

Shell calls per implementer agent (kinds assigned by pattern on the first command of each call, so the rows are approximate):

| Kind | Calls per agent |
| --- | --- |
| read file via shell | 30.0 |
| test | 22.3 |
| other | 21.7 |
| lint / typecheck / format / architecture | 15.9 |
| search / list via shell | 15.3 |
| git | 10.9 |
| CI status | 3.6 |
| sleep / wait | 2.9 |
| gh (other) | 2.8 |

## 4. What to compare later

The changes of 2026-11-16 aim at these numbers:

| Change | Number it should move |
| --- | --- |
| Implementer on `model: sonnet` | Implementer list price per agent (baseline 14.2) |
| Parallel lookups, **Read first** list | Read / search shell calls per agent (baseline 45.3 together); one-tool turns (87%) |
| One chained verify command, fix all failures per run | Test and lint calls per agent (baseline 38.2 together) |
| One blocking CI wait | CI status and sleep calls per agent (baseline 6.5 together) |
| Smaller output | Implementer context per turn (baseline 281k) |
| Narrower standards sources, delta re-review | Independent reviewer and review sub-agent list price per agent (baseline 5.3 and 0.6) |

A cheaper implementer is only a gain if quality holds. The transcripts do not show review rounds: one reviewer context served each PR in the baseline, so rounds happened inside it. Take **review rounds until approval** and **BLOCKER / MAJOR findings per PR** from the review summaries on the PRs, and compare those for Stories before and after the change.

## 5. Measuring a later period

```bash
node scripts/agent-usage.mjs <transcript-dir> --since 2026-11-17
```

`<transcript-dir>` is this project's folder under `~/.claude/projects/`. `--since` and `--until` filter on the day a transcript started. Compare per-agent values, not totals: the number of Stories differs between periods, and so does their size.

## 6. Limits

- Roles are assigned from the first prompt of each sub-agent by keyword; a differently worded brief lands in "other sub-agent".
- Only Claude Code sessions on one machine are counted. Codex sessions and sessions on other machines are not.
- Transcripts are removed by Claude Code's own retention, so a past period cannot be re-measured later. That is why the numbers are recorded here.
