/*
  Warnings:

  - You are about to drop the column `refreshToken` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `refreshTokenExpires` on the `Session` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "ShopConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "assistantName" TEXT NOT NULL DEFAULT 'AI Shopping Assistant',
    "assistantTagline" TEXT NOT NULL DEFAULT 'Smart Support for Every Step',
    "greeting" TEXT NOT NULL DEFAULT 'Hi! I''m your personal shopping assistant.',
    "greetingCta" TEXT NOT NULL DEFAULT 'What can I help you find today?',
    "avatarUrl" TEXT NOT NULL DEFAULT '',
    "bannerUrl" TEXT NOT NULL DEFAULT '',
    "colorPrimary" TEXT NOT NULL DEFAULT '#2d6b4f',
    "colorAccent" TEXT NOT NULL DEFAULT '#e8f5ee',
    "colorCtaBg" TEXT NOT NULL DEFAULT '#e8f5ee',
    "colorCtaText" TEXT NOT NULL DEFAULT '#2d6b4f',
    "colorCtaHover" TEXT NOT NULL DEFAULT '#d6eee0',
    "launcherPlaceholder" TEXT NOT NULL DEFAULT 'How can I help you today?',
    "inputPlaceholder" TEXT NOT NULL DEFAULT 'How can I help you today?',
    "launcherWidth" TEXT NOT NULL DEFAULT '500',
    "widgetPosition" TEXT NOT NULL DEFAULT 'bottom-center',
    "showBanner" BOOLEAN NOT NULL DEFAULT true,
    "cta1Label" TEXT NOT NULL DEFAULT '',
    "cta1Message" TEXT NOT NULL DEFAULT '',
    "cta2Label" TEXT NOT NULL DEFAULT '',
    "cta2Message" TEXT NOT NULL DEFAULT '',
    "cta3Label" TEXT NOT NULL DEFAULT '',
    "cta3Message" TEXT NOT NULL DEFAULT '',
    "cta4Label" TEXT NOT NULL DEFAULT '',
    "cta4Message" TEXT NOT NULL DEFAULT '',
    "qp1Label" TEXT NOT NULL DEFAULT '',
    "qp1Message" TEXT NOT NULL DEFAULT '',
    "qp2Label" TEXT NOT NULL DEFAULT '',
    "qp2Message" TEXT NOT NULL DEFAULT '',
    "qp3Label" TEXT NOT NULL DEFAULT '',
    "qp3Message" TEXT NOT NULL DEFAULT '',
    "qp4Label" TEXT NOT NULL DEFAULT '',
    "qp4Message" TEXT NOT NULL DEFAULT '',
    "ctaHint" TEXT NOT NULL DEFAULT '',
    "disclaimerText" TEXT NOT NULL DEFAULT 'Powered by AI',
    "privacyUrl" TEXT NOT NULL DEFAULT '/pages/privacy-policy',
    "anthropicApiKey" TEXT NOT NULL DEFAULT '',
    "anthropicModel" TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    "yotpoApiKey" TEXT NOT NULL DEFAULT '',
    "aftershipApiKey" TEXT NOT NULL DEFAULT '',
    "chatServerUrl" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "KnowledgeFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" DATETIME,
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false
);
INSERT INTO "new_Session" ("accessToken", "accountOwner", "collaborator", "email", "emailVerified", "expires", "firstName", "id", "isOnline", "lastName", "locale", "scope", "shop", "state", "userId") SELECT "accessToken", "accountOwner", "collaborator", "email", "emailVerified", "expires", "firstName", "id", "isOnline", "lastName", "locale", "scope", "shop", "state", "userId" FROM "Session";
DROP TABLE "Session";
ALTER TABLE "new_Session" RENAME TO "Session";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ShopConfig_shop_key" ON "ShopConfig"("shop");

-- CreateIndex
CREATE INDEX "KnowledgeFile_shop_idx" ON "KnowledgeFile"("shop");
