-- Issue #76 (ADR 0001 amendment): every stored secret carries the owner label its business
-- module stored it under (for example `projects.deploy-key`), so a module can find its own
-- secrets that nothing references any more and delete them, without touching another
-- module's. The label is not secret; values and ciphertext stay as they are.
--
-- Backfill: until now only Deploy keys were stored, but a row no Repository references cannot
-- be told apart from anything else, so only the referenced rows become `projects.deploy-key`.
-- Every other existing row becomes `unowned`, a label no module stores or sweeps.

ALTER TABLE "secrets" ADD COLUMN "owner" VARCHAR(64);

UPDATE "secrets" SET "owner" = 'projects.deploy-key'
WHERE "id" IN (SELECT "deploy_key_secret_id" FROM "repositories" WHERE "deploy_key_secret_id" IS NOT NULL);

UPDATE "secrets" SET "owner" = 'unowned' WHERE "owner" IS NULL;

ALTER TABLE "secrets" ALTER COLUMN "owner" SET NOT NULL;

-- Lower-case dot-separated segments of letters, digits and hyphens (the adapter checks it too).
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_owner_check"
    CHECK ("owner" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$');

-- Serves listing one owner's secrets older than an age.
CREATE INDEX "secrets_owner_created_at_idx" ON "secrets"("owner", "created_at");
