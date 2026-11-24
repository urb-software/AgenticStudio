-- Work for the environment controller (Issue #275): one row per operation on a Project's Preview,
-- and the redacted lines of its log. Nothing creates a row in production yet.
-- Rollback: DROP TABLE "preview_operation_lines"; DROP TABLE "preview_operations".

-- CreateTable
CREATE TABLE "preview_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "commit" CHAR(40),
    "compose_file" VARCHAR(255),
    "service" VARCHAR(63),
    "port" INTEGER,
    "memory_mib" INTEGER,
    "cpu_percent" INTEGER,
    "tasks_max" INTEGER,
    "build_minutes" INTEGER,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "claimed_by" UUID,
    "claimed_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "failure_code" VARCHAR(32),
    "failure_detail" VARCHAR(2000),
    "refusals" JSONB,
    "result" JSONB,
    "environment_file_path" VARCHAR(255),
    "environment_file_secret_id" UUID,
    "log_bytes" INTEGER NOT NULL DEFAULT 0,
    "log_truncated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "preview_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preview_operation_lines" (
    "operation_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "stream" VARCHAR(16) NOT NULL,
    "text" VARCHAR(2048) NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "preview_operation_lines_pkey" PRIMARY KEY ("operation_id","seq")
);

-- CreateIndex
CREATE INDEX "preview_operations_status_requested_at_idx" ON "preview_operations"("status", "requested_at");

-- AddForeignKey
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preview_operation_lines" ADD CONSTRAINT "preview_operation_lines_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "preview_operations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints or partial indexes: added by hand.
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_kind_check"
    CHECK ("kind" IN ('build', 'stop', 'remove_data', 'state'));
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_status_check"
    CHECK ("status" IN ('requested', 'claimed', 'succeeded', 'failed'));

-- The build columns are set exactly when the operation is a build.
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_build_columns_check"
    CHECK (
      ("kind" = 'build'
        AND "commit" IS NOT NULL AND "compose_file" IS NOT NULL AND "service" IS NOT NULL
        AND "port" IS NOT NULL AND "memory_mib" IS NOT NULL AND "cpu_percent" IS NOT NULL
        AND "tasks_max" IS NOT NULL AND "build_minutes" IS NOT NULL)
      OR
      ("kind" <> 'build'
        AND "commit" IS NULL AND "compose_file" IS NULL AND "service" IS NULL
        AND "port" IS NULL AND "memory_mib" IS NULL AND "cpu_percent" IS NULL
        AND "tasks_max" IS NULL AND "build_minutes" IS NULL)
    );
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_build_ranges_check"
    CHECK (
      "kind" <> 'build'
      OR ("port" BETWEEN 1 AND 65535
          AND "memory_mib" BETWEEN 128 AND 65536
          AND "cpu_percent" BETWEEN 10 AND 6400
          AND "tasks_max" BETWEEN 64 AND 32768
          AND "build_minutes" BETWEEN 1 AND 120)
    );

-- The lease columns follow the status; a final operation keeps who held it and since when.
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_claim_check"
    CHECK (
      ("status" = 'requested'
        AND "claimed_by" IS NULL AND "claimed_at" IS NULL AND "heartbeat_at" IS NULL)
      OR ("status" = 'claimed'
        AND "claimed_by" IS NOT NULL AND "claimed_at" IS NOT NULL AND "heartbeat_at" IS NOT NULL)
      OR ("status" IN ('succeeded', 'failed')
        AND "heartbeat_at" IS NULL AND ("claimed_by" IS NULL) = ("claimed_at" IS NULL))
    );
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_failure_check"
    CHECK (("status" = 'failed') = ("failure_code" IS NOT NULL AND "failure_detail" IS NOT NULL));
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_finished_check"
    CHECK (("status" IN ('succeeded', 'failed')) = ("finished_at" IS NOT NULL));
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_log_bytes_check"
    CHECK ("log_bytes" >= 0);
ALTER TABLE "preview_operations" ADD CONSTRAINT "preview_operations_environment_file_check"
    CHECK ("environment_file_secret_id" IS NULL OR "environment_file_path" IS NOT NULL);

ALTER TABLE "preview_operation_lines" ADD CONSTRAINT "preview_operation_lines_stream_check"
    CHECK ("stream" IN ('build', 'start', 'controller'));
ALTER TABLE "preview_operation_lines" ADD CONSTRAINT "preview_operation_lines_seq_check"
    CHECK ("seq" >= 1);

-- At most one claimed operation per Project: the backstop of the hand-out.
CREATE UNIQUE INDEX "preview_operations_one_claimed_per_project"
    ON "preview_operations" ("project_id") WHERE "status" = 'claimed';
