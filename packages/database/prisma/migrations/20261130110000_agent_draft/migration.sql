-- The Draft of the definitions Repository: one row for its base commit and version, and a row per
-- file it adds, changes or deletes. It reaches no agent.
-- Rollback: DROP TABLE "agent_draft_files"; DROP TABLE "agent_drafts".

-- CreateTable
CREATE TABLE "agent_drafts" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "base_commit" VARCHAR(64),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_draft_files" (
    "path" VARCHAR(255) NOT NULL,
    "change" VARCHAR(16) NOT NULL,
    "content" BYTEA,
    "size" INTEGER NOT NULL,
    "moved_from" VARCHAR(255),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "agent_draft_files_pkey" PRIMARY KEY ("path")
);

-- Prisma cannot express CHECK constraints: added by hand.
ALTER TABLE "agent_drafts" ADD CONSTRAINT "agent_drafts_single_check"
    CHECK ("id" = 1);

ALTER TABLE "agent_draft_files" ADD CONSTRAINT "agent_draft_files_change_check"
    CHECK ("change" IN ('added', 'modified', 'deleted'));

ALTER TABLE "agent_draft_files" ADD CONSTRAINT "agent_draft_files_content_check"
    CHECK (("change" = 'deleted') = ("content" IS NULL));

ALTER TABLE "agent_draft_files" ADD CONSTRAINT "agent_draft_files_moved_from_check"
    CHECK ("moved_from" IS NULL OR "change" <> 'deleted');

-- The one Draft always has its row, so a write can be conditional on its version.
INSERT INTO "agent_drafts" ("id", "version", "updated_at") VALUES (1, 0, now());
