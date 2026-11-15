-- Environment files (Issue #104): one per Project, its content in the secret store, and what a
-- Run records about the snapshot it was given.

-- CreateTable
CREATE TABLE "environment_files" (
    "project_id" UUID NOT NULL,
    "path" VARCHAR(255) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "secret_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "environment_files_pkey" PRIMARY KEY ("project_id")
);

-- AddForeignKey
ALTER TABLE "environment_files" ADD CONSTRAINT "environment_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "environment_file_supplied" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "runs" ADD COLUMN "environment_file_secret_id" UUID;

-- Prisma cannot express CHECK constraints: added by hand.
ALTER TABLE "environment_files" ADD CONSTRAINT "environment_files_size_bytes_check"
    CHECK ("size_bytes" >= 0 AND "size_bytes" <= 65536);
ALTER TABLE "environment_files" ADD CONSTRAINT "environment_files_path_check"
    CHECK (char_length("path") >= 1);
-- A Run holds a snapshot secret only when it was supplied an Environment file.
ALTER TABLE "runs" ADD CONSTRAINT "runs_environment_file_secret_check"
    CHECK ("environment_file_secret_id" IS NULL OR "environment_file_supplied");
