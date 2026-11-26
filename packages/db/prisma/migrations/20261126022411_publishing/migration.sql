-- DropIndex
DROP INDEX "PublicationTarget_status_idx";

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "url" TEXT;

-- AlterTable
ALTER TABLE "Publication" ADD COLUMN     "groupIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';

-- AlterTable
ALTER TABLE "PublicationTarget" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "externalUrl" TEXT,
ADD COLUMN     "scheduledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "PublicationTarget_status_scheduledAt_idx" ON "PublicationTarget"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "PublicationTarget_socialAccountId_scheduledAt_idx" ON "PublicationTarget"("socialAccountId", "scheduledAt");
