-- Issue #76 (ADR 0001 amendment): every stored secret carries the owner label its business
-- module stored it under (for example `projects.deploy-key`), so a module can find its own
-- secrets that nothing references any more and delete them, without touching another
-- module's. The label is not secret; values and ciphertext stay as they are.
--
-- Backfill (operator decision on #76): the Deploy key is the only secret Studio has ever
-- stored, so every existing row becomes `projects.deploy-key`, referenced or not. An
-- unreferenced one is an orphan from before this change, which the sweep then deletes once it
-- is past the grace period. The format below also admits `unowned`, kept for future use.

ALTER TABLE "secrets" ADD COLUMN "owner" VARCHAR(64);

UPDATE "secrets" SET "owner" = 'projects.deploy-key';

ALTER TABLE "secrets" ALTER COLUMN "owner" SET NOT NULL;

-- Lower-case dot-separated segments of letters, digits and hyphens (the adapter checks it too).
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_owner_check"
    CHECK ("owner" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$');

-- Serves listing one owner's secrets older than an age.
CREATE INDEX "secrets_owner_created_at_idx" ON "secrets"("owner", "created_at");
