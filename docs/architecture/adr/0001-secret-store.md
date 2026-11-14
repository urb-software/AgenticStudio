---
status: accepted
date: 2026-11-13
---

# Secrets are encrypted in PostgreSQL behind a `SecretStore` port

Decided by the operator in the Epic #55 refinement, 2026-11-13.

Connecting private Repositories makes Studio hold the first secrets it must store and later decrypt: the private half of each per-project Deploy key. We store such secrets encrypted in PostgreSQL with AES-256-GCM, behind a `SecretStore` port, so that application state and its secrets share one backup and one source of truth while the plaintext never reaches the database, Git, logs or API responses. The master key comes from the environment (`STUDIO_SECRETS_KEY`, 32 random bytes, base64) and is never stored in the database; every encrypted record carries a key-version field so that a later rotation can tell which key sealed it.

## Considered Options

- **Plain files in the data directory** (for example key files next to the Clones): no encryption at rest, a second backup target that must stay consistent with PostgreSQL, and file permissions as the only protection. Rejected.
- **An external secret manager** (a hosted vault or cloud key service): stronger key custody and rotation, but a new runtime dependency, network access and operational cost for a single-operator, self-hosted MVP. Rejected for now; the `SecretStore` port keeps it open as a later adapter.
- **Encrypted in PostgreSQL behind a port, master key from the environment.** Chosen.

## Consequences

- **One backup target:** a PostgreSQL backup contains the encrypted secrets; restoring them also needs the master key.
- **A lost master key means reconnecting Repositories:** encrypted secrets cannot be recovered without it; the operator disconnects and connects again, which generates new Deploy keys that must be registered on the Git host.
- **Rotation tooling is deferred:** the key-version field makes rotation possible later, but no rotation command exists yet.
- Only the `SecretStore` adapter handles the ciphertext and the master key; callers hold references and resolve the plaintext only at the point of authorized use ([Security](../../engineering/security.md) §3).

## Amendment (Issue #76, 2026-11-14)

Every stored secret carries the **owner label** of the business module that stored it (`put(value, { owner })`, for example `projects.deploy-key`), in a non-secret `owner` column. `listOlderThan(owner, ageMs)` returns the references, never the values, of one owner's secrets older than an age measured by the store's clock. This lets a module delete its own secrets that nothing references any more without touching another module's: `projects` sweeps unreferenced Deploy keys older than a one-hour grace period at start-up and after a failed delete, logging each deleted secret by its id only. The migration labels every existing secret `projects.deploy-key`, since Deploy keys are the only secrets Studio has ever stored, so orphans from before the change are swept too. The label format also admits `unowned`, kept for future use.
