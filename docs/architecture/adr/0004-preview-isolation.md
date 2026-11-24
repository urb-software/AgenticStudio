---
status: accepted
date: 2026-11-22
---

# Previews run under a third operating-system user with its own rootless Docker

Decided by the operator in the refinement of the Preview Epic (#271), 2026-11-22. The Preview's network access was confirmed by the operator on 2026-11-23 (see [Network decision](#network-decision-2026-11-23)).

A Project's Preview is the Project's own Compose stack, built from the Integration branch. Its Compose file comes from the Repository, so it is untrusted code. Previews run on the host as a third user (the **Preview user**), with its own rootless Docker daemon used only for Previews. The `environment-controller` runs as that user. This replaces the earlier statement that the controller is part of Studio's stack under the system Docker daemon. [ADR 0002](0002-agent-run-isolation.md) still decides the isolation of Runs; nothing in it changes.

## Context

- **A Preview starts a Repository's Compose stack.** A hostile or mistaken Compose file can ask for privileged containers, the host network or the Docker socket.
- **The system Docker daemon is root-equivalent.** Anything that can start a container there can take over Studio, its secrets and the server ([ADR 0002](0002-agent-run-isolation.md)).
- **The agent side already holds credentials.** The agent user has CLI logins and the agent account's token, so a Preview must not share its daemon.
- **One operator, one dedicated server**, with no production credentials on it.

## Decision

- **A third operating-system user, the Preview user.** It is not in the `docker` group, has no passwordless `sudo`, and has no access to Studio's files or to the agent user's files.
- **Its own rootless Docker daemon**, used only for Previews. A Compose file started there can reach only what the Preview user can reach.
- **The controller runs on the host as the Preview user** and always calls Studio; Studio never reaches into the host. It claims Preview work over its own routes with its own token, limited to Preview work. That token cannot handle Runs, and the agent worker's token cannot handle Previews.
- **The boundary is the operating system.** A hostile Compose file can at most damage other Previews. Validating the Compose file before anything starts is the second line of defence, not the boundary.
- **No Git credential on the Preview side.** The API hands the controller an archive of the Integration branch at the merged commit, made from the Project's Clone, together with the Environment file's content. The controller never reads a Working copy.
- **The agent worker and the agents have no access to Preview credentials or to the Preview user's daemon.**
- **Reaching a Preview.** The settled rules are in [Security](../../engineering/security.md) §5: a hostname per Project under a separate preview domain, a Preview password at the reverse proxy, and routing to exactly one service. How the reverse proxy in Studio's stack reaches a service of the Preview user's daemon without opening it to the network is **not decided here**. A routing trial (#273) settles it; its record is [Trial report: a Preview user's rootless Docker and routing](0004-trial-preview-routing.md).

### Network decision (2026-11-23)

Decided by the operator on 2026-11-23, in a comment on Epic #271.

- Outbound internet access is allowed for builds and at run time, as it is for Runs.
- Studio's internal services (database, queue, the API's internal address) and the host's loopback are blocked, and a test proves the blocking.
- **Accepted risk:** Preview code can send anywhere whatever it can read, which is the Environment file's test values and its own data.

## Considered Options

- **The system Docker with validation.** The controller runs in Studio's stack and starts Previews under the system daemon after checking the Compose file. Rejected: the system daemon is root-equivalent, so one gap in the validation takes over Studio and the server. The boundary would be a list of refusals.
- **The agent user's rootless daemon.** Previews and Runs share one daemon. Rejected: a Preview's code could read the agent user's CLI logins and tokens, and an agent could reach every Preview's containers and data.
- **A third user, the Preview user, with its own rootless daemon.** Chosen.

## Consequences and accepted risks

- **A hostile Compose file can damage other Previews.** They share the Preview user and its daemon. Previews of different Projects are kept apart by the Compose validation and the per-Preview limits only, not by the operating system.
- **Validation is the second line of defence.** A gap in it leaves the Preview user's rights as the limit, not Studio's.
- **Outbound network access is allowed.** See [Network decision](#network-decision-2026-11-23).
- **A kernel vulnerability could cross the boundary**, as for Runs. Keeping the host patched is part of the model.
- **One more user, daemon and service on the server.** The server setup creates them and checks them.
- **The agent side must not read the Preview user's files or socket**; the server setup checks it.
- **Routing is unsettled until the trial (#273)** records its result.

## Upgrade paths

Stronger isolation needs a separate decision.
