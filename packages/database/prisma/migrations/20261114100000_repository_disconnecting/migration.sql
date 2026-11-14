-- Story #63: disconnecting a repository. The state machine gains `disconnecting`: the operator
-- disconnected the repository and Studio is still removing its data; the row is deleted last,
-- which frees its url_normalized for another connect. Only CHECK constraints change (Prisma
-- does not model them); no column is added.

ALTER TABLE "repositories" DROP CONSTRAINT "repositories_state_check";
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_state_check"
    CHECK ("state" IN ('connecting', 'ready', 'fetching', 'failed', 'disconnecting'));

-- ready and fetching need a Clone; connecting never has one (the clone job starts clean), and
-- neither has disconnecting (its Clone is being removed).
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_clone_state_check";
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_clone_state_check"
    CHECK (
        ("state" NOT IN ('ready', 'fetching') OR "head_sha" IS NOT NULL)
        AND ("state" NOT IN ('connecting', 'disconnecting') OR "head_sha" IS NULL)
    );
