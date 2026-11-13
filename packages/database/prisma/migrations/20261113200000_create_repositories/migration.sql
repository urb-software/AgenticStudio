-- Story #60: the `repositories` table. One row per project at most (the primary key is the
-- project id); the unique index on url_normalized keeps one remote from being connected to
-- two projects, whatever URL form was entered (Issue #60 clarification 6). Nothing here is
-- secret: failure_detail holds redacted Git output only.

-- CreateTable
CREATE TABLE "repositories" (
    "project_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "url_normalized" TEXT NOT NULL,
    "integration_branch" VARCHAR(255) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "head_sha" VARCHAR(64),
    "last_fetched_at" TIMESTAMPTZ(6),
    "failure_code" VARCHAR(32),
    "failure_detail" VARCHAR(2000),
    "failure_remote_default_branch" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("project_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repositories_url_normalized_key" ON "repositories"("url_normalized");

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defence in depth on the state machine (the adapter writes only these combinations). Prisma
-- does not model CHECK constraints, so they live only here, and schema diffs ignore them.
-- Later stories that add states or codes replace these constraints.
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_state_check"
    CHECK ("state" IN ('connecting', 'ready', 'failed'));
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_failure_code_check"
    CHECK ("failure_code" IN ('auth_failed', 'host_unreachable', 'host_key_mismatch', 'repository_not_found', 'branch_not_found', 'timeout', 'size_limit', 'unknown'));
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_failure_when_failed_check"
    CHECK (("state" = 'failed') = ("failure_code" IS NOT NULL AND "failure_detail" IS NOT NULL));
