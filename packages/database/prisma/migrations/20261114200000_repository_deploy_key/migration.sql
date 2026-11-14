-- Story #62: private repositories over SSH with a Deploy key. A Repository gains the reference
-- to its Deploy key's private half in the secret store (never the key itself), the public half,
-- the host key pinned after the operator confirmed it, and the retrieved host key awaiting
-- confirmation. The state machine gains `awaiting_key` and `awaiting_host_key`. No key material
-- is stored here: the secret store holds the private key, encrypted.

ALTER TABLE "repositories"
    ADD COLUMN "deploy_key_secret_id" UUID,
    ADD COLUMN "public_key" VARCHAR(1024),
    ADD COLUMN "pinned_host_key" VARCHAR(8192),
    ADD COLUMN "pending_host_key" VARCHAR(8192);

ALTER TABLE "repositories" DROP CONSTRAINT "repositories_state_check";
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_state_check"
    CHECK ("state" IN ('awaiting_key', 'awaiting_host_key', 'connecting', 'ready', 'fetching', 'failed', 'disconnecting'));

-- ready and fetching need a Clone; connecting, disconnecting and the two awaiting states never
-- have one.
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_clone_state_check";
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_clone_state_check"
    CHECK (
        ("state" NOT IN ('ready', 'fetching') OR "head_sha" IS NOT NULL)
        AND ("state" NOT IN ('connecting', 'disconnecting', 'awaiting_key', 'awaiting_host_key') OR "head_sha" IS NULL)
    );

-- The public half and the private half's reference go together.
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_deploy_key_check"
    CHECK (("deploy_key_secret_id" IS NULL) = ("public_key" IS NULL));

-- Only an SSH Repository (one with a Deploy key, until a Disconnect removes it) waits for a key
-- or pins a host key.
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_ssh_state_check"
    CHECK (
        ("state" NOT IN ('awaiting_key', 'awaiting_host_key') OR "deploy_key_secret_id" IS NOT NULL)
        AND ("pinned_host_key" IS NULL OR "deploy_key_secret_id" IS NOT NULL)
    );

-- A retrieved host key awaits confirmation exactly in awaiting_host_key.
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_pending_host_key_check"
    CHECK (("state" = 'awaiting_host_key') = ("pending_host_key" IS NOT NULL));
