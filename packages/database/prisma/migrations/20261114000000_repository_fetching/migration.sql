-- Story #61: fetching a connected repository. The state machine gains `fetching`, and a usable
-- Clone is recorded by its commit: head_sha (with last_fetched_at) is set exactly while one
-- exists, so a failed fetch that keeps the Clone stays fetchable and a failed connect does not.
-- Only CHECK constraints change (Prisma does not model them); no column is added.

ALTER TABLE "repositories" DROP CONSTRAINT "repositories_state_check";
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_state_check"
    CHECK ("state" IN ('connecting', 'ready', 'fetching', 'failed'));

-- The commit and the fetch time of the Clone come and go together.
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_clone_fields_check"
    CHECK (("head_sha" IS NULL) = ("last_fetched_at" IS NULL));

-- ready and fetching need a Clone; connecting never has one (the clone job starts clean).
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_clone_state_check"
    CHECK (
        ("state" NOT IN ('ready', 'fetching') OR "head_sha" IS NOT NULL)
        AND ("state" <> 'connecting' OR "head_sha" IS NULL)
    );
