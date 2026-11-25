-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'TIKTOK', 'YOUTUBE', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "VideoFormat" AS ENUM ('VERTICAL_9_16', 'HORIZONTAL_16_9', 'SQUARE_1_1', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING_AUTH', 'CONNECTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'READY_FOR_APPROVAL', 'APPROVED', 'SCHEDULED', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'RETRY_SCHEDULED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AIProviderKind" AS ENUM ('UNIFIED', 'DIRECT');

-- CreateEnum
CREATE TYPE "AIAdapterType" AS ENUM ('OPENAI_COMPATIBLE');

-- CreateEnum
CREATE TYPE "AIModality" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO');

-- CreateEnum
CREATE TYPE "AITask" AS ENUM ('SCRIPT', 'SCRIPT_REVISION', 'CAPTION', 'IMAGE', 'VIDEO', 'NARRATION');

-- CreateEnum
CREATE TYPE "SelectionMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "AIJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('REPORTED', 'COMPUTED');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('CREDIT', 'DEBIT', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "monthlyBudget" DECIMAL(14,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountGroup" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultFormat" "VideoFormat" NOT NULL DEFAULT 'FLEXIBLE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "platform" "SocialPlatform" NOT NULL,
    "platformAccountId" TEXT,
    "displayName" TEXT NOT NULL,
    "handle" TEXT,
    "connectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'PENDING_AUTH',
    "tokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMembership" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "name" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "format" "VideoFormat" NOT NULL DEFAULT 'FLEXIBLE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "projectId" TEXT,
    "mediaAssetId" TEXT,
    "title" TEXT,
    "body" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicationTarget" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platformTitle" TEXT,
    "platformBody" TEXT,
    "status" "PostStatus" NOT NULL DEFAULT 'SCHEDULED',
    "platformPostId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PublicationTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIProvider" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AIProviderKind" NOT NULL DEFAULT 'UNIFIED',
    "adapter" "AIAdapterType" NOT NULL DEFAULT 'OPENAI_COMPATIBLE',
    "baseUrl" TEXT NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "secretHint" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIModel" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerModelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "modalities" "AIModality"[],
    "pricing" JSONB,
    "pricingSource" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "supportsAsync" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AITaskPreference" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "task" "AITask" NOT NULL,
    "mode" "SelectionMode" NOT NULL DEFAULT 'AUTO',
    "modelId" TEXT,
    "fallbackModelIds" TEXT[],

    CONSTRAINT "AITaskPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT,
    "providerModelId" TEXT NOT NULL,
    "requestedBy" TEXT,
    "task" "AITask" NOT NULL,
    "modality" "AIModality" NOT NULL,
    "selectionMode" "SelectionMode" NOT NULL,
    "routeReason" TEXT,
    "prompt" TEXT NOT NULL,
    "params" JSONB,
    "status" "AIJobStatus" NOT NULL DEFAULT 'QUEUED',
    "providerRequestId" TEXT,
    "estimatedCost" DECIMAL(14,6),
    "reservedAmount" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "actualCost" DECIMAL(14,6),
    "costSource" "CostSource",
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "outputText" TEXT,
    "outputUrl" TEXT,
    "outputStorageKey" TEXT,
    "outputMimeType" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AIJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "balance" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "monthlyLimit" DECIMAL(14,6),
    "allowUnpricedModels" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLedger" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "clientId" TEXT,
    "aiJobId" TEXT,
    "type" "LedgerType" NOT NULL,
    "amount" DECIMAL(14,6) NOT NULL,
    "balanceAfter" DECIMAL(14,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Member_workspaceId_email_key" ON "Member"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "Client_workspaceId_idx" ON "Client"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_workspaceId_name_key" ON "Client"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Project_clientId_idx" ON "Project"("clientId");

-- CreateIndex
CREATE INDEX "AccountGroup_workspaceId_idx" ON "AccountGroup"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountGroup_workspaceId_name_key" ON "AccountGroup"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "SocialAccount_workspaceId_platform_idx" ON "SocialAccount"("workspaceId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_workspaceId_platform_platformAccountId_key" ON "SocialAccount"("workspaceId", "platform", "platformAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_workspaceId_platform_displayName_key" ON "SocialAccount"("workspaceId", "platform", "displayName");

-- CreateIndex
CREATE INDEX "GroupMembership_socialAccountId_idx" ON "GroupMembership"("socialAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMembership_groupId_socialAccountId_key" ON "GroupMembership"("groupId", "socialAccountId");

-- CreateIndex
CREATE INDEX "MediaAsset_workspaceId_createdAt_idx" ON "MediaAsset"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Publication_workspaceId_scheduledAt_status_idx" ON "Publication"("workspaceId", "scheduledAt", "status");

-- CreateIndex
CREATE INDEX "PublicationTarget_status_idx" ON "PublicationTarget"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PublicationTarget_publicationId_socialAccountId_key" ON "PublicationTarget"("publicationId", "socialAccountId");

-- CreateIndex
CREATE INDEX "AIProvider_workspaceId_isActive_idx" ON "AIProvider"("workspaceId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AIProvider_workspaceId_name_key" ON "AIProvider"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AIModel_providerId_providerModelId_key" ON "AIModel"("providerId", "providerModelId");

-- CreateIndex
CREATE UNIQUE INDEX "AITaskPreference_workspaceId_task_key" ON "AITaskPreference"("workspaceId", "task");

-- CreateIndex
CREATE INDEX "AIJob_workspaceId_status_createdAt_idx" ON "AIJob"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AIJob_clientId_createdAt_idx" ON "AIJob"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_workspaceId_key" ON "Wallet"("workspaceId");

-- CreateIndex
CREATE INDEX "UsageLedger_workspaceId_createdAt_idx" ON "UsageLedger"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageLedger_clientId_createdAt_idx" ON "UsageLedger"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageLedger_aiJobId_idx" ON "UsageLedger"("aiJobId");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountGroup" ADD CONSTRAINT "AccountGroup_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AccountGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationTarget" ADD CONSTRAINT "PublicationTarget_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublicationTarget" ADD CONSTRAINT "PublicationTarget_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIProvider" ADD CONSTRAINT "AIProvider_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIModel" ADD CONSTRAINT "AIModel_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AIProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AITaskPreference" ADD CONSTRAINT "AITaskPreference_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AITaskPreference" ADD CONSTRAINT "AITaskPreference_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AIModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AIProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIJob" ADD CONSTRAINT "AIJob_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AIModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLedger" ADD CONSTRAINT "UsageLedger_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLedger" ADD CONSTRAINT "UsageLedger_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
