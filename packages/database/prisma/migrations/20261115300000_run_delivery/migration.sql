-- Issue #102: delivering a Run's result as a draft pull request. A Run records the integration
-- branch it targets, how it was delivered, its pull request, a requested delivery retry and the
-- checks the agent reported failed. Additive, except that the claim CHECK constraint is
-- replaced so an agent worker can hold a failed Run while it retries the delivery.
-- Rollback: drop the six columns and the new CHECK constraints, restore runs_claim_check.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "delivery" VARCHAR(16),
ADD COLUMN     "delivery_requested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "failing_checks" JSONB,
ADD COLUMN     "integration_branch" VARCHAR(255),
ADD COLUMN     "pull_request_number" INTEGER,
ADD COLUMN     "pull_request_url" VARCHAR(2048);

-- Existing Runs take their project's current integration branch; a Run whose project has no
-- Repository any more gets an empty one (it has no remote either and is never delivered).
UPDATE "runs" SET "integration_branch" = r."integration_branch"
    FROM "repositories" r WHERE r."project_id" = "runs"."project_id";
UPDATE "runs" SET "integration_branch" = '' WHERE "integration_branch" IS NULL;
ALTER TABLE "runs" ALTER COLUMN "integration_branch" SET NOT NULL;

-- Delivery outcomes: none or delivered only for a succeeded Run, failed only for a Run that
-- failed with delivery_failed; the pull request exactly when delivered.
ALTER TABLE "runs" ADD CONSTRAINT "runs_delivery_check"
    CHECK ("delivery" IS NULL
        OR ("delivery" IN ('none', 'delivered') AND "state" = 'succeeded')
        OR ("delivery" = 'failed' AND "state" = 'failed' AND "failure_code" = 'delivery_failed'));
ALTER TABLE "runs" ADD CONSTRAINT "runs_pull_request_check"
    CHECK (("pull_request_url" IS NULL) = ("pull_request_number" IS NULL)
       AND ("pull_request_url" IS NOT NULL) = COALESCE("delivery" = 'delivered', false));
-- A delivery retry is requested only for a Run whose delivery failed.
ALTER TABLE "runs" ADD CONSTRAINT "runs_delivery_requested_check"
    CHECK (NOT "delivery_requested" OR ("state" = 'failed' AND "failure_code" = 'delivery_failed'));
-- A worker holds a Run while it is preparing or running, or while it retries the delivery of a
-- failed Run (replaces the constraint of Issue #96).
ALTER TABLE "runs" DROP CONSTRAINT "runs_claim_check";
ALTER TABLE "runs" ADD CONSTRAINT "runs_claim_check"
    CHECK (("state" IN ('preparing', 'running') AND "claimed_by" IS NOT NULL)
        OR ("state" NOT IN ('preparing', 'running')
            AND ("claimed_by" IS NULL OR ("state" = 'failed' AND "delivery_requested"))));
