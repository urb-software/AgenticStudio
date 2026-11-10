---
name: studio-tdd
description: Test-driven development for AI Agent Studio (Vitest, Supertest, Testcontainers, React Testing Library, Playwright). Use when building features or fixing bugs test-first, on "red-green-refactor", or when writing integration tests.
---

<!-- Forked from mattpocock-skills 1.3.1 `tdd` (MIT). See ../THIRD_PARTY_NOTICES.md. -->

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle: consult them before and during the loop, not after.

When exploring the codebase, read `docs/architecture/glossary.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect the canonical docs and ADRs in `docs/architecture/adr/` in the area you're touching. The test stack, placement and determinism rules are canonical in `docs/engineering/quality.md` §3 and §6.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification: "operator can create a project with a unique name" tells you exactly what capability exists, and it survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the operator, unless the Issue or implementation handoff already lists approved seams; then use those. No test is written at an unconfirmed seam. You can't test everything, so agreeing the seams up front is how testing effort lands on the critical paths and complex logic instead of every edge case.

Ask: "What's the public interface, and which seams should we test?" Give each proposed seam a one-line note on what it catches and what it misses.

Typical seams in this repo, highest first:

| Seam | Tooling | Catches |
| --- | --- | --- |
| Full user flow (Next.js → API → DB) | Playwright | Critical journeys, smoke |
| HTTP endpoint of a feature | Vitest + Supertest (+ Testcontainers PostgreSQL/Redis) | Auth, validation, persistence, transactions |
| Feature handler through its ports | Vitest (+ `@nestjs/testing` where useful) | Business rules, domain transitions, negative cases |
| Business module public entry point | Vitest | Cross-module contract |
| Frontend feature / component | Vitest + React Testing Library | Forms, loading/error states, accessibility-sensitive interactions |
| API / event contract | Zod + OpenAPI checks | Payload validity, version compatibility |

When the shape of that interface is itself in question (how deep the module is, where the seam belongs, what the interface should expose), call the Skill tool with "studio-codebase-design" for the vocabulary. It is a reference to consult, not a session to run.

## Repo rules on doubles and determinism

- Persistence tests use a real PostgreSQL via Testcontainers, not a mocked ORM.
- Provider CLIs (Claude Code, Codex) are always **Fake Runners** in regular tests; real CLI smoke tests run only in a separate controlled stage.
- Pin clocks and seeds; isolate DBs and fixtures. A flaky test is tracked and its cause fixed, never retried until green.
- Security-relevant behavior needs **negative** tests (unauthorized, forbidden path, disabled provider, malformed input), asserted at the real boundary (e.g. the process-spawn boundary, not just a returned status). See `quality.md` §10.

## Placement

Feature tests live near the feature in `__tests__/` where practical; system-level E2E, security and contract suites live in repo-level `tests/`; fixtures and fakes shared by several apps live in `packages/testing/`.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth: a known-good literal, a worked example, the acceptance criteria.
- **Horizontal slicing**: writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead: one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage (see the `studio-code-review` skill), not the red → green implementation cycle.
- **Never weaken a test, auth check or architecture gate to get green.** Report the failure instead.
