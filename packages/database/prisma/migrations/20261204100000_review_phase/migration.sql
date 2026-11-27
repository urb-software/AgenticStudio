-- A Phase may be a review Phase, and a review Phase stores its Verdict and what it found. The
-- Run's "review not passed" is derived from the Phases, so the Run has no new column. ONE-WAY
-- DOOR: once a review Phase exists, narrowing the kind CHECK back to 'work' needs those Runs
-- deleted or changed first.
-- Rollback: ALTER TABLE "run_phases" DROP CONSTRAINT "run_phases_verdict_check"; DROP COLUMN
-- "verdict", "findings"; restore run_phases_kind_state_check with "kind" IN ('work') (no Run may
-- hold a review Phase by then).

-- AlterTable
ALTER TABLE "run_phases" ADD COLUMN     "verdict" VARCHAR(24),
ADD COLUMN     "findings" JSONB;

ALTER TABLE "run_phases" DROP CONSTRAINT "run_phases_kind_state_check";
ALTER TABLE "run_phases" ADD CONSTRAINT "run_phases_kind_state_check" CHECK (
    "kind" IN ('work', 'review')
    AND "state" IN ('pending', 'running', 'done', 'failed')
);

-- Prisma cannot express CHECK constraints: added by hand.
ALTER TABLE "run_phases" ADD CONSTRAINT "run_phases_verdict_check" CHECK (
    ("verdict" IS NULL) = ("findings" IS NULL)
    AND ("verdict" IS NULL OR ("kind" = 'review' AND "verdict" IN ('approved', 'changes_requested')))
    AND ("findings" IS NULL OR jsonb_typeof("findings") = 'array')
);
