-- A Project's Preview settings (Issue #276): the Compose file, the service and the port its
-- Preview routes to. One row per Project.
-- Rollback: DROP TABLE "preview_settings".

-- CreateTable
CREATE TABLE "preview_settings" (
    "project_id" UUID NOT NULL,
    "compose_file" VARCHAR(255) NOT NULL,
    "service" VARCHAR(63) NOT NULL,
    "port" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "preview_settings_pkey" PRIMARY KEY ("project_id")
);

-- AddForeignKey
ALTER TABLE "preview_settings" ADD CONSTRAINT "preview_settings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express CHECK constraints: added by hand.
ALTER TABLE "preview_settings" ADD CONSTRAINT "preview_settings_compose_file_check"
    CHECK (char_length("compose_file") >= 1);
ALTER TABLE "preview_settings" ADD CONSTRAINT "preview_settings_service_check"
    CHECK ("service" ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$');
ALTER TABLE "preview_settings" ADD CONSTRAINT "preview_settings_port_check"
    CHECK ("port" >= 1 AND "port" <= 65535);
