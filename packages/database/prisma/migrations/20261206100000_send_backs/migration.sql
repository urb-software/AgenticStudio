-- A review Phase may send work back to the work Phase before it, within the Workflow's limit. The
-- Run keeps its limit as recorded, one count of the send-backs it used and the review Phase that
-- is to run again; a Phase keeps the results of its earlier rounds. Additive: nothing is dropped,
-- so it can be rolled back by dropping the constraints and the columns.

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "workflow_send_backs" INTEGER,
ADD COLUMN     "send_backs_used" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "send_back_review" INTEGER;

-- AlterTable
ALTER TABLE "run_phases" ADD COLUMN     "rounds" JSONB NOT NULL DEFAULT '[]';

-- A Run started before this migration was claimed under "changes requested end the Workflow":
-- it keeps that meaning, so its recorded limit is none. Only plans recorded from now on get the
-- Workflow's number (default 2).
UPDATE "runs" SET "workflow_send_backs" = 0 WHERE "workflow_name" IS NOT NULL;

-- Prisma cannot express CHECK constraints: added by hand. No limit is above two, and a Run
-- that is not a Workflow Run has no send-back.
ALTER TABLE "runs" ADD CONSTRAINT "runs_send_backs_check" CHECK (
    ("workflow_send_backs" IS NULL OR ("workflow_send_backs" BETWEEN 0 AND 2 AND "workflow_name" IS NOT NULL))
    AND "send_backs_used" BETWEEN 0 AND 2
    AND ("send_back_review" IS NULL OR ("send_back_review" >= 0 AND "workflow_name" IS NOT NULL))
);

ALTER TABLE "run_phases" ADD CONSTRAINT "run_phases_rounds_check" CHECK (
    jsonb_typeof("rounds") = 'array'
);
