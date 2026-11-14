# Claude Code CLI — Compliance Decision (2026-11-14)

- **Issue:** #86 (B6), parent Epic #84
- **Provider / CLI:** Anthropic, Claude Code CLI, version 2.1.325 (latest release on the official changelog, dated November 13, 2026)
- **Decision:** Needs Clarification — operator decision and headless test pending
- **Accepted by (operator):** pending
- **Decision date:** pending
- **Next review date:** three months after the decision date
- **Records prepared on:** 2026-11-14

This record reports what Anthropic's published pages say on the date read. It is not legal advice. Accepting any remaining ambiguity is the operator's decision. `CLAUDE_CODE_ENABLED` stays `false`; this record changes no runtime configuration.

## Intended use (what is validated)

- The CLI is started by Studio's agent worker on **one Linux server**, running as an **ordinary user** (not root, not in the `docker` group, no passwordless `sudo`).
- Each run is a sequence of **non-interactive steps** (`claude -p`) that stream events, end with a structured result, and can be **resumed by session id**.
- Runs start **only on the operator's action** (later also from a workflow the operator started), **never** on a timer or an outside event.
- **At most two runs at a time.** Runs continue while the operator is away.
- **The operator's own projects, one operator, the operator's own everyday account.** Nobody else signs in, triggers runs or receives the output.
- Authentication: the operator's **own subscription login first**; an **API key** from the operator's own Claude Console organization is the fallback.

## Terms and documentation reviewed

All sources are Anthropic's own pages. The Claude Code documentation pages and help-centre articles carry no effective date; the version column gives what the page shows. All pages were read on 2026-11-14.

| #   | Source                                                           | URL                                                                                              | Version / effective date                                                                         | Reviewed on |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------- |
| S1  | Consumer Terms of Service                                        | https://www.anthropic.com/legal/consumer-terms                                                   | Effective Oct 8, 2025 (version shown for consumers resident in the EEA or Switzerland, see note) | 2026-11-14  |
| S2  | Commercial Terms of Service                                      | https://www.anthropic.com/legal/commercial-terms                                                 | Effective Jun 17, 2025                                                                           | 2026-11-14  |
| S3  | Usage Policy (AUP)                                               | https://www.anthropic.com/legal/aup                                                              | Effective Nov 12, 2026                                                                           | 2026-11-14  |
| S4  | Claude Code Docs — Legal and compliance                          | https://code.claude.com/docs/en/legal-and-compliance                                             | Undated; current for CLI 2.1.325                                                                 | 2026-11-14  |
| S5  | Claude Code Docs — Authentication                                | https://code.claude.com/docs/en/authentication                                                   | Undated; current for CLI 2.1.325                                                                 | 2026-11-14  |
| S6  | Claude Code Docs — Run Claude Code programmatically (`-p`)       | https://code.claude.com/docs/en/headless                                                         | Undated; current for CLI 2.1.325                                                                 | 2026-11-14  |
| S7  | Claude Code Docs — CLI reference                                 | https://code.claude.com/docs/en/cli-reference                                                    | Undated; current for CLI 2.1.325                                                                 | 2026-11-14  |
| S8  | Claude Code Docs — Permissions                                   | https://code.claude.com/docs/en/permissions                                                      | Undated; current for CLI 2.1.325                                                                 | 2026-11-14  |
| S9  | Claude Code Docs — Changelog                                     | https://code.claude.com/docs/en/changelog                                                        | Latest entry 2.1.325, November 13, 2026                                                          | 2026-11-14  |
| S10 | Help Centre — Use Claude Code with your Pro, Max, or Ultra plan  | https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan        | "Updated over 2 weeks ago" (no date shown)                                                       | 2026-11-14  |
| S11 | Help Centre — Use the Claude Agent SDK with your Claude plan     | https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan   | "Updated over 2 weeks ago"; updates dated June 15, 2026 and October 7, 2026                      | 2026-11-14  |
| S12 | Help Centre — Monthly API credits for Max, Ultra, and Team plans | https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans | "Updated over 2 weeks ago" (no date shown)                                                       | 2026-11-14  |

Note on S1: the page has regional versions. The text quoted below is from the version for consumers resident in the EEA or Switzerland; the operator confirms which regional version applies to the account. The clause quoted from §3 is the one relevant here.

### Quotes relied on

**Which terms govern Claude Code (S4, "License"):**

> Your use of Claude Code is subject to:
>
> - Commercial Terms of Service - for Team, Enterprise, and Claude API users
> - Consumer Terms of Service - for Free, Pro, Max, and Ultra users

**Automated access under the consumer terms (S1, §3 "Use of our Services"):** among the uses that are not allowed:

> Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.

**Account sharing (S1, §2):**

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else or make your Account available to anyone else.

**API keys fall under the commercial terms (S1, preamble):**

> Please note: Our Commercial Terms of Service govern your use of any Anthropic API key, the Anthropic Console, or any other Anthropic offerings that reference the Commercial Terms of Service.

**Scope of the commercial terms (S2):**

> They govern Customer’s use of Anthropic API keys and any other Anthropic offerings that references these Terms, as well as all related Anthropic tools, documentation and services (the “Services”).

**Usage limits assume ordinary, individual use (S4, "Acceptable use"):**

> Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK.

**OAuth (subscription) authentication (S4, "Authentication and credential use"):**

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.

**Developers building products (S4):**

> **Developers** building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

**Own API keys and own subscription sign-in (S4):**

> This does not restrict how customers provision and manage their own API keys or third-party inference provider credentials — for example, configuring an API key in a development environment, secrets manager, or machine image for use by the customer's own authorized users — provided the resulting usage is billed to the key owner under their agreement with Anthropic (or the applicable provider) and is not resold or intermediated as described above. Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under _Can customers offer Claude Code in their products?_ above.

> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

**Running Claude Code in products or agent infrastructure (S4, "Can customers offer Claude Code in their products?"):** the section opens with

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below:

and the first condition is

> **The Claude Code binary must not be modified.** Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).

The second condition is that customers "may not pay for, resell, or intermediate Claude usage on their end users' behalf". These conditions are stated for running Claude Code in a customer's "products or services". Whether Studio, a personal tool used only by the operator, falls in that scope is unclear (see the subscription assessment).

**Usage Policy (S3):**

> This includes individuals using our apps (such as Claude.ai and Claude Code), […]

Among prohibited uses:

> Resell, proxy, or otherwise provide access to Claude through unauthorized means, including services that route requests through consumer subscriptions or misrepresent the product or client being used

> Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products, including by circumvention of the account sign-up or log-in process […]

On agentic use:

> Agentic use cases must comply with the Usage Policy. Users are responsible for ensuring that agents they build or deploy, including actions those agents take through tools, browsers, or connected systems, comply with this Usage Policy.

**`claude -p` with a subscription (S11):**

> Update October 7, 2026: Claude Max, Ultra, and Team plans now include monthly API credits. They cover the Claude API, Claude Managed Agents, and the Claude Agent SDK and claude -p when you run them with an API key from your linked Claude Console organization. Nothing changes for your plan: when you’re signed in with your Claude plan, the Claude Agent SDK and claude -p still draw from your subscription limits.

> Update June 15, 2026: We’ve paused the previously-announced changes to Claude Agent SDK usage. For now, nothing has changed: Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription limits.

**Shared plan limits and API-key billing (S10):**

> These limits are shared across Claude and Claude Code, meaning all activity in both tools counts against the same limits.

> Important: If you have an ANTHROPIC_API_KEY environment variable set on your system, Claude Code will use this API key for authentication instead of your Claude subscription (Pro, Max, Ultra, Team, or Enterprise plans), resulting in API usage charges rather than using your subscription's included usage.

**Monthly API credits (S12):** the credits cover, among others,

> The Claude Agent SDK

and do not apply to

> Interactive Claude Code in the terminal, IDE, desktop, or web

## Authentication

### Assessment — subscription login (first choice)

| Clearly permitted                                                                                                                                                                                                                                                    | Clearly not permitted                                                                                                                            | Unclear / silent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing in to the **unmodified** Claude Code binary with the operator's **own** subscription through Anthropic's own flow (S4: "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription").           | Sharing the login or making the account available to anyone else (S1 §2).                                                                        | Whether an **unattended** server worker, running while the operator is away, is "ordinary, individual usage" (S4) and "ordinary use of Claude Code" (S4). The pages do not define either term.                                                                                                                                                                                                                                                                                                                                     |
| Running `claude -p` while signed in with a plan: S11 states that `claude -p` "still draw[s] from your subscription limits", and S5/S6 document scripted use. This is the strongest evidence that some scripted subscription use is "explicitly permit[ted]" (S1 §3). | Collecting, storing or intermediating Claude.ai credentials or session tokens, or offering Claude.ai login inside Studio (S4).                   | Whether S1 §3 ("automated or non-human means, whether through a bot, script") is satisfied by S11's statement, i.e. whether that statement is an explicit permission or only a billing note. S1 itself names only the API key exception.                                                                                                                                                                                                                                                                                           |
|                                                                                                                                                                                                                                                                      | Routing requests through consumer subscriptions on behalf of other users, reselling or proxying access (S3, S4).                                 | Whether Studio, built and used only by the operator, counts as "Developers building products or services that interact with Claude's capabilities" who "should use API key authentication" (S4). That first sentence is not limited to third parties; only the prohibition in the next sentence ("Anthropic does not permit third-party developers to offer Claude.ai login [...] or to route requests [...] on behalf of their users") is. Studio has no other users, but the pages do not address a single developer's own tool. |
|                                                                                                                                                                                                                                                                      | Modifying the binary or removing its authentication methods, where the S4 products-section conditions apply (Studio keeps this rule regardless). | Whether **two concurrent** unattended runs fit "ordinary, individual usage" (S4). No page gives a concurrency figure.                                                                                                                                                                                                                                                                                                                                                                                                              |
|                                                                                                                                                                                                                                                                      |                                                                                                                                                  | Whether logging in the same everyday account on a separate Linux server (in addition to the operator's own machine) is treated differently. No page restricts the number of machines; none permits it explicitly either.                                                                                                                                                                                                                                                                                                           |
|                                                                                                                                                                                                                                                                      |                                                                                                                                                  | Long-lived token (`claude setup-token`, `CLAUDE_CODE_OAUTH_TOKEN`): S5 documents it "For CI pipelines, scripts, or other environments where interactive browser login isn't available", but it would put a subscription token into Studio's configuration, which is close to "store" in S4. Not selected.                                                                                                                                                                                                                          |
|                                                                                                                                                                                                                                                                      |                                                                                                                                                  | Whether Studio's worker, which runs Claude Code on a server, counts as running it "in your products or services (e.g. in hosted sandboxes or other agent infrastructure)" (S4). If it does, S4 says this "requires agreeing to our Commercial Terms of Service", which govern API keys (S1 preamble, S2), not the Consumer Terms under which the subscription is used. S4 frames the section around customers offering Claude Code to their end users; it does not address a single person's own tool.                             |

**Result for subscription login: unclear.** The official text neither clearly permits nor clearly forbids the intended use. Anthropic states it may enforce "without prior notice" (S4), so the risk falls on the operator's everyday account.

### Assessment — API key (fallback)

| Clearly permitted                                                                                                                                                                   | Clearly not permitted                                  | Unclear / silent                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Automated access with an API key is the stated exception in S1 §3 ("Except when you are accessing our Services via an Anthropic API Key").                                          | Sharing the key with anyone else (S1 §2).              | Nothing found that is unclear for the intended use. Cost and spend limits are an operational question, not a terms question (`--max-budget-usd` exists, S7). |
| Developers building tools "should use API key authentication through Claude Console" (S4).                                                                                          | Reselling or intermediating usage for others (S4, S3). |                                                                                                                                                              |
| Provisioning the operator's own key "in a development environment, secrets manager, or machine image for use by the customer's own authorized users", billed to the key owner (S4). | Modifying the binary (S4).                             |                                                                                                                                                              |
| `claude -p` and the Agent SDK with a key from a linked Console organization are covered by plan-included monthly API credits on eligible plans (S11, S12).                          |                                                        |                                                                                                                                                              |

**Result for API key: permitted** under the Commercial Terms (S2), subject to the Usage Policy (S3).

### Selected method

Not yet selected. Proposed: subscription login only after Anthropic answers the clarification question (see Open questions); API key path usable now if the operator accepts it.

### How credentials are provisioned to the worker (without extraction, interception, sharing or proxying)

- **Subscription login:** the operator signs in **once, interactively**, as the worker's ordinary host user, with `claude auth login` (S7), which completes in Anthropic's own browser flow. The CLI stores the login itself; on Linux "credentials are stored in `~/.claude/.credentials.json` with file mode `0600`" (S5). The worker only starts the CLI binary as that user. Studio and the worker never read, copy, parse, log, transmit or back up that file, never receive the token, and never place it in an environment variable, database, secret store or container. No request passes through any Studio proxy: the unmodified CLI talks to Anthropic directly. Logging out (`claude auth logout`, S7: "Log out from your Anthropic account") removes the worker's stored login; the pages do not say whether this also revokes the token on Anthropic's side.
- **API key:** the operator creates a key in their own Claude Console organization. The deployment configuration supplies it to the worker process as `ANTHROPIC_API_KEY` (S5: "In non-interactive mode (`-p`), the key is always used when present"), held in the host user's protected configuration, never in Git, logs, event streams or the Studio database. Usage is billed to the operator's own organization. The key is used only by the operator's own runs and can be revoked in the Console.
- In both cases the agent's own processes must not be able to print the credential into run logs; this is a requirement for the worker story (security.md §3).

## Permitted execution mode and restrictions

### Mode

Non-interactive `claude -p` steps (S6). Options intended, each verified against S6/S7 for CLI 2.1.325 (placeholders in angle brackets):

```text
# first step
claude -p "<task prompt>" \
  --output-format stream-json --verbose \
  --permission-mode dontAsk --permission-prompts none \
  --allowedTools "<Studio-approved tool rules>" \
  --setting-sources user \
  --settings <Studio guardrail settings file> \
  --strict-mcp-config \
  --max-turns <n>

# next step (operator's answer, or a follow-up)
claude -p "<operator answer>" --resume <session-id> <same options>
```

- `--output-format stream-json --verbose`: newline-delimited JSON events (S6). The event tables in S6 list a `session_id` field; S6 has no statement that every event carries it, so the headless test confirms where it appears. The run ends with a result event; exit code 0 on success, non-zero on failure (S6).
- `--resume <session-id>`: continues a specific conversation (S6, S7).
- `--permission-mode dontAsk` and `--permission-prompts none`: anything that would prompt is denied instead of waiting (S6). `--permission-prompts none` requires v2.1.259 or later (S7).
- `--setting-sources user` and `--strict-mcp-config`: the project's settings files and `.mcp.json` are not read (S8, S7). Studio's own hooks and permission rules come from `--settings`; hooks are guardrails, not the security boundary.
- With the API key path, add `--bare` on top of these options (see technical findings); with subscription login `--bare` cannot be used.
- Cost guard for the API key path: `--max-budget-usd <amount>` (S7).

### Restrictions

- Subscription plan limits apply and are "shared across Claude and Claude Code" (S10); S4 says advertised limits "assume ordinary, individual usage". Runs that hit a limit must fail or pause visibly.
- Studio runs the binary as published, unmodified, with no authentication method removed. S4 states this as a condition for running Claude Code "in your products or services"; Studio adopts it as its own rule whether or not that scope applies.
- No sharing of the account or key (S1 §2); no reselling, proxying or routing for others (S3, S4).
- Agents and their tool actions must comply with the Usage Policy (S3, "Agentic use").
- Studio may say in plain text that it runs Claude Code, but may not use the Claude Code or Anthropic names or logos as part of its own product name or logo (S4).

### Technical findings that affect the design

1. **Bare mode and the planned default.** S6: "Add `--bare` to reduce startup time by skipping auto-discovery of hooks, skills, custom commands, subagents, installed plugins, MCP servers, auto memory, and CLAUDE.md." S6 also: "In bare mode, Claude Code never reads OAuth credentials or the system keychain." and "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release." S5: "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`." **Consequence:** when bare becomes the default, a subscription-login worker would need a way to opt out of it; no opt-out is documented yet, so without one the subscription path stops working. Studio's hooks passed with `--settings` also do not run in bare mode (S6: "Hooks still don't run in bare mode when you pass them with `--settings`"). The API key path works with bare mode. A CLI release that makes bare the default is a revalidation trigger.
2. **Non-interactive runs load project hooks and MCP servers without a trust prompt.** S6: "Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted. A `-p` session shows no workspace trust dialog and no per-server approval prompt." S8 lists hooks, the `env` block and `apiKeyHelper` as "Used" and `.mcp.json` servers as "Connected without asking, approved or not" under `claude -p`. **Consequence:** the worker must start with `--setting-sources user` (S8: "so Claude Code reads neither the project's settings files nor its `.mcp.json`") and `--strict-mcp-config`. `--bare` alone is not enough: S8 says that with `--bare` "The project's `env` block and helpers such as `awsAuthRefresh` in its settings files still apply", so the API key path uses `--bare` plus `--setting-sources user`. This feeds the Epic #84 open decision on repository-supplied agent configuration.
3. **The built-in "ask the user" tool is unavailable when prompts are disabled.** S6: "With `--permission-prompts none`, Claude Code removes the tools that need an answer from a person, such as `AskUserQuestion`, so Claude can't call them." In `dontAsk` mode S6 also says `AskUserQuestion` is "denied even when an allow rule matches". **Consequence:** the "agent asks, run pauses, operator answers" flow cannot use `AskUserQuestion`. It needs another mechanism, for example the agent ending the step with a question in its result and the operator's answer sent with `--resume`, or a Studio-provided permission or MCP tool. To be decided in the worker story.
4. Since v2.1.302 a `claude -p` run starts in Manual mode when nothing sets a permission mode, and a call that needs approval is denied unless something approves it (S6).
5. With `ANTHROPIC_API_KEY` present, `-p` always uses it (S5), and the run is billed to the key (S10). S5's precedence list also ranks `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper` and `CLAUDE_CODE_OAUTH_TOKEN` above the `/login` subscription credentials, so the subscription worker's environment and settings must contain none of them.

## Controlled headless execution test

- **Status: pending.** At the time of writing the CLI is not installed in the test environment, and the test needs the operator's own login. It is run by the operator (or with the operator's explicit OK to install the CLI and use its stored login).
- Environment: Linux (WSL on the operator's machine), CLI 2.1.325 or later, logged in as the operator with the subscription login; a throwaway Git repository in a temporary directory; trivial task; no real project code.
- Command(s) (redacted):
  - `claude -p "<trivial task>" --output-format stream-json --verbose --permission-mode dontAsk --permission-prompts none --allowedTools "Read,Edit" --setting-sources user --strict-mcp-config --max-turns 5`
  - `claude -p "<follow-up>" --resume <session-id> <same options>`
- Result / evidence: pending — to record exit status of each step, event types seen, session id present (yes/no), resume continues the same session (yes/no). Output captured redacted: no account name, email, plan tier, hostname, token, session file or transcript.

## Revalidation triggers

- Anthropic updates the Consumer Terms, Commercial Terms, Usage Policy, or the Claude Code "Legal and compliance" page.
- A help-centre change about `claude -p` or Agent SDK use with a subscription (S11 records a paused change that may resume).
- New major CLI version, or a release that makes `--bare` the default for `-p`.
- Change of authentication method (subscription ↔ API key, long-lived token, other provider).
- Move to a different server, or more than one server.
- Change in how runs are started (timers, outside events, other people), or the concurrency limit rises above two.
- Next review date passes.

## Open questions / notes

- **Operator decision:** accept the remaining ambiguity for subscription login, ask Anthropic first (draft question in PR), or use the API key path.
- **Channel for the question:** S4 says "For questions about permitted authentication methods for your use case, please contact sales." The draft question is addressed to that channel.
- **Headless test:** pending; to be run by the operator.
- The help-centre articles show no exact update date; re-read them at each review.
- Not legal advice. No account name, plan tier, email, hostname, token, session file or unredacted output is recorded here.
