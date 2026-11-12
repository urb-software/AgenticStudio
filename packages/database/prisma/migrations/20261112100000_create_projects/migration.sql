-- Story #16: the `projects` table. The unique index on name_normalized enforces
-- case-insensitive name uniqueness (Epic #8 decision 2).

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "name_normalized" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_name_normalized_key" ON "projects"("name_normalized");

-- CreateIndex
CREATE INDEX "projects_created_at_id_idx" ON "projects"("created_at" DESC, "id" DESC);

