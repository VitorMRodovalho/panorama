-- CreateTable
CREATE TABLE "import_identity_map" (
    "id" BIGSERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "panoramaId" UUID NOT NULL,
    "tenantId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_identity_map_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_identity_map_source_entity_panoramaId_idx" ON "import_identity_map"("source", "entity", "panoramaId");

-- CreateIndex
CREATE UNIQUE INDEX "import_identity_map_source_entity_sourceId_key" ON "import_identity_map"("source", "entity", "sourceId");
