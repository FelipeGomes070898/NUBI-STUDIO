-- CreateEnum
CREATE TYPE "VideoProjectStatus" AS ENUM ('QUEUED', 'PLANNING', 'GENERATING', 'RENDERING', 'READY', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SceneStatus" AS ENUM ('PENDING', 'SUBMITTED', 'DONE', 'FAILED');

-- AlterEnum
ALTER TYPE "AIAdapterType" ADD VALUE 'GOOGLE_GEMINI';

-- AlterTable
ALTER TABLE "AccountGroup" ADD COLUMN     "characterId" TEXT;

-- AlterTable
ALTER TABLE "Publication" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "thumbnailUrl" TEXT;

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "referenceUrls" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "groupId" TEXT,
    "characterId" TEXT,
    "prompt" TEXT NOT NULL,
    "targetSeconds" INTEGER NOT NULL,
    "aspect" TEXT NOT NULL,
    "status" "VideoProjectStatus" NOT NULL DEFAULT 'QUEUED',
    "step" TEXT,
    "error" TEXT,
    "titles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "selectedTitle" TEXT,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "thumbUrl" TEXT,
    "thumbJobId" TEXT,
    "thumbError" TEXT,
    "finalUrl" TEXT,
    "finalMediaId" TEXT,
    "estimatedCost" DECIMAL(14,6),
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoScene" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,
    "status" "SceneStatus" NOT NULL DEFAULT 'PENDING',
    "aiJobId" TEXT,
    "clipUrl" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "VideoScene_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Character_workspaceId_name_key" ON "Character"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "VideoProject_workspaceId_createdAt_idx" ON "VideoProject"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "VideoProject_status_idx" ON "VideoProject"("status");

-- CreateIndex
CREATE UNIQUE INDEX "VideoScene_projectId_index_key" ON "VideoScene"("projectId", "index");

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Character" ADD CONSTRAINT "Character_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AccountGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoProject" ADD CONSTRAINT "VideoProject_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoScene" ADD CONSTRAINT "VideoScene_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "VideoProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
