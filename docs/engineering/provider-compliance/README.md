# Provider Compliance Decision Records

One dated record per provider validation (Technical Tasks B6 Claude Code CLI, B7 Codex CLI). Policy: [Security](../security.md) §2.

- File name: `YYYY-MM-DD-<provider>.md`, e.g. `2026-11-20-claude-code-cli.md`. A revalidation adds a new record; do not rewrite an accepted one.
- A record is applicable only while its decision is `Approved`, its next review date has not passed, and no revalidation trigger has occurred.
- Setting `CLAUDE_CODE_ENABLED` / `CODEX_CLI_ENABLED` is a separate operator action; the record does not change runtime configuration.
- Never include credentials, tokens, session files or unredacted logs in a record.

## Record template

```markdown
# <Provider> CLI — Compliance Decision (<YYYY-MM-DD>)

- **Issue:** #...
- **Provider / CLI:** <name>, version <x.y.z>
- **Decision:** Approved | Rejected | Needs Clarification
- **Accepted by (operator):** ...
- **Decision date:** YYYY-MM-DD
- **Next review date:** YYYY-MM-DD

## Terms and documentation reviewed
| Source | URL | Version / effective date | Reviewed on |
| --- | --- | --- | --- |
| | | | |

## Authentication
- Selected method: ...
- How credentials are provisioned to the worker (without extraction, interception, sharing or proxying): ...

## Permitted execution mode and restrictions
- Mode (e.g. non-interactive command, flags): ...
- Restrictions (rate limits, usage limits, prohibited uses): ...

## Controlled headless execution test
- Environment: ...
- Command(s) (redacted): ...
- Result / evidence: ...

## Revalidation triggers
- CLI major version change, provider terms update, authentication method change, ...

## Open questions / notes
- ...
```
