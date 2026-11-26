-- CreateEnum
CREATE TYPE "PublicationKind" AS ENUM ('POST', 'STORY');

-- DropIndex
DROP INDEX "PublicationTarget_socialAccountId_scheduledAt_idx";

-- AlterTable
ALTER TABLE "Publication" ADD COLUMN     "kind" "PublicationKind" NOT NULL DEFAULT 'POST';

-- AlterTable
ALTER TABLE "PublicationTarget" ADD COLUMN     "kind" "PublicationKind" NOT NULL DEFAULT 'POST';

-- CreateTable
CREATE TABLE "WeeklyGoal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "kind" "PublicationKind" NOT NULL,
    "target" INTEGER NOT NULL,

    CONSTRAINT "WeeklyGoal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WeeklyGoal_workspaceId_idx" ON "WeeklyGoal"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyGoal_socialAccountId_kind_key" ON "WeeklyGoal"("socialAccountId", "kind");

-- CreateIndex
CREATE INDEX "PublicationTarget_socialAccountId_kind_scheduledAt_idx" ON "PublicationTarget"("socialAccountId", "kind", "scheduledAt");

-- AddForeignKey
ALTER TABLE "WeeklyGoal" ADD CONSTRAINT "WeeklyGoal_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
