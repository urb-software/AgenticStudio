-- Issue #142: where a Run's pull request stands on the Git host, and the lookups through which
-- an agent worker reads it. The Run keeps the last known state (kept when a later lookup fails)
-- in eight additive, nullable columns; `run_lookups` holds Studio's requests for the worker (one
-- open request per Run and kind) and their results; later kinds (Pull request checks, Review
-- comments) reuse it.
-- Rollback (only once no lookup is wanted): drop table run_lookups and the eight pr_* columns of
-- runs with their CHECK constraint.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "pr_ahead_by" INTEGER,
ADD COLUMN     "pr_behind_by" INTEGER,
ADD COLUMN     "pr_mergeable" BOOLEAN,
ADD COLUMN     "pr_refresh_error" VARCHAR(500),
ADD COLUMN     "pr_refresh_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "pr_refreshed_at" TIMESTAMPTZ(6),
ADD COLUMN     "pr_retry_at" TIMESTAMPTZ(6),
ADD COLUMN     "pr_state" VARCHAR(16);

-- Prisma cannot express CHECK constraints or partial indexes: added by hand.
ALTER TABLE "runs" ADD CONSTRAINT "runs_pull_request_state_check"
    CHECK (("pr_state" IS NULL OR "pr_state" IN ('draft', 'open', 'merged', 'closed', 'missing'))
       AND ("pr_state" IS NULL) = ("pr_refreshed_at" IS NULL)
       AND ("pr_behind_by" IS NULL OR "pr_behind_by" >= 0)
       AND ("pr_ahead_by" IS NULL OR "pr_ahead_by" >= 0)
       AND ("pr_state" IS NOT NULL OR ("pr_behind_by" IS NULL AND "pr_ahead_by" IS NULL AND "pr_mergeable" IS NULL)));

-- CreateTable
CREATE TABLE "run_lookups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "claimed_by" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "result" JSONB,
    "error" VARCHAR(500),
    "retry_at" TIMESTAMPTZ(6),

    CONSTRAINT "run_lookups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_lookups_status_requested_at_idx" ON "run_lookups"("status", "requested_at");

-- CreateIndex
CREATE INDEX "run_lookups_run_id_idx" ON "run_lookups"("run_id");

-- AddForeignKey
ALTER TABLE "run_lookups" ADD CONSTRAINT "run_lookups_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "run_lookups" ADD CONSTRAINT "run_lookups_kind_check"
    CHECK ("kind" IN ('pull_request_state'));
ALTER TABLE "run_lookups" ADD CONSTRAINT "run_lookups_status_check"
    CHECK ("status" IN ('requested', 'claimed', 'done', 'failed')
       AND ("status" <> 'requested' OR ("claimed_by" IS NULL AND "claimed_at" IS NULL))
       AND ("status" <> 'claimed' OR ("claimed_by" IS NOT NULL AND "claimed_at" IS NOT NULL))
       AND (("status" IN ('done', 'failed')) = ("finished_at" IS NOT NULL)));

-- At most one open (requested or claimed) lookup per Run and kind.
CREATE UNIQUE INDEX "run_lookups_one_open_key" ON "run_lookups"("run_id", "kind")
    WHERE "status" IN ('requested', 'claimed');
