# Project skills (`studio-*`)

Optional Claude Code skills that help each role follow the SDLC in [`docs/engineering/agent-roles.md`](../../docs/engineering/agent-roles.md). They are **aids, not authority**: `AGENTS.md` and `docs/` remain canonical, skills point to them instead of copying policy, and no skill grants a permission. Where a skill and a canonical doc disagree, the doc wins and the skill should be fixed.

| Stage / role | Skills |
| --- | --- |
| Refinement (operator + coordinator) | `studio-grilling`, `studio-grill-with-docs`, `studio-domain-modeling`, `studio-to-spec` (Epic), `studio-to-tickets` (Stories / Technical Tasks) |
| Design | `studio-codebase-design`, `studio-improve-codebase-architecture`, `studio-prototype` |
| Coordinator → implementer | `studio-handoff implementer #<n>` |
| Implementer | `studio-implement`, `studio-tdd`, `studio-diagnosing-bugs`, `studio-pr`, `studio-handoff return #<n>` |
| Independent reviewer (fresh context) | `studio-code-review` |

Conventions the skills assume:

- Domain glossary: `docs/architecture/glossary.md`; ADRs: `docs/architecture/adr/NNNN-slug.md` (both created lazily, changed only through PRs).
- Skills with `disable-model-invocation: true` run only when invoked explicitly (`/studio-<name>`).
- Claude Code only. Codex follows the same policy through `AGENTS.md` and `docs/`.

Provenance and license: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
