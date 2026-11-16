-- A Run's diffs (Issue #144): the latest "whole Run" diff and the latest "since the previous
-- result" diff per Run, as the agent worker reported them after a Run step's result, with each
-- file's patch (redacted like the log) in its own row, keyed by the file's position in the list
-- (a path can be longer than an index entry may be). Kept after the Working copy is removed;
-- removed with the Run.

-- CreateTable
CREATE TABLE "run_diffs" (
    "run_id" UUID NOT NULL,
    "scope" VARCHAR(8) NOT NULL,
    "base_commit" VARCHAR(64),
    "includes_unpushed" BOOLEAN NOT NULL DEFAULT false,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "files" JSONB NOT NULL,
    "unavailable_reason" VARCHAR(500),
    "reported_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "run_diffs_pkey" PRIMARY KEY ("run_id","scope")
);

-- CreateTable
CREATE TABLE "run_diff_files" (
    "run_id" UUID NOT NULL,
    "scope" VARCHAR(8) NOT NULL,
    "position" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "patch" TEXT NOT NULL,

    CONSTRAINT "run_diff_files_pkey" PRIMARY KEY ("run_id","scope","position")
);

-- Where a Run's diffs stand (review S-1 of #149): the trees and commits of the latest and the
-- previous result, and the Run branch tip the worker last pushed. Kept by Studio for the
-- worker, handed back with a resume or delivery claim; object ids only.
-- CreateTable
CREATE TABLE "run_diff_states" (
    "run_id" UUID NOT NULL,
    "result_tree" VARCHAR(64) NOT NULL,
    "result_commit" VARCHAR(64) NOT NULL,
    "previous_tree" VARCHAR(64) NOT NULL,
    "previous_commit" VARCHAR(64) NOT NULL,
    "pushed_commit" VARCHAR(64),

    CONSTRAINT "run_diff_states_pkey" PRIMARY KEY ("run_id")
);

-- AddForeignKey
ALTER TABLE "run_diff_states" ADD CONSTRAINT "run_diff_states_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_diffs" ADD CONSTRAINT "run_diffs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_diff_files" ADD CONSTRAINT "run_diff_files_run_id_scope_fkey" FOREIGN KEY ("run_id", "scope") REFERENCES "run_diffs"("run_id", "scope") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints: added by hand. A diff has a base commit, or the
-- reason it could not be computed (and then no files).
ALTER TABLE "run_diffs" ADD CONSTRAINT "run_diffs_scope_check" CHECK ("scope" IN ('run', 'last'));
ALTER TABLE "run_diffs" ADD CONSTRAINT "run_diffs_base_check"
    CHECK (("base_commit" IS NULL) = ("unavailable_reason" IS NOT NULL));
ALTER TABLE "run_diff_files" ADD CONSTRAINT "run_diff_files_position_check" CHECK ("position" >= 0);
ALTER TABLE "run_diff_states" ADD CONSTRAINT "run_diff_states_ids_check" CHECK (
    "result_tree" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND "result_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND "previous_tree" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND "previous_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
    AND ("pushed_commit" IS NULL OR "pushed_commit" ~ '^([0-9a-f]{40}|[0-9a-f]{64})$')
);
