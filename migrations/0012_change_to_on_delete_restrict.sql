-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AccessToken" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AccessToken" ("createdAt", "id", "name", "token", "type", "userId") SELECT "createdAt", "id", "name", "token", "type", "userId" FROM "AccessToken";
DROP TABLE "AccessToken";
ALTER TABLE "new_AccessToken" RENAME TO "AccessToken";
CREATE UNIQUE INDEX "AccessToken_token_key" ON "AccessToken"("token");
CREATE TABLE "new_ApiKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "providerName" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "keyData" JSONB NOT NULL,
    "throttleData" JSONB NOT NULL,
    "notes" TEXT,
    "permanentlyFailed" BOOLEAN NOT NULL DEFAULT false,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "baseUrl" TEXT,
    "availableModels" JSONB,
    CONSTRAINT "ApiKey_providerName_fkey" FOREIGN KEY ("providerName") REFERENCES "Provider" ("name") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApiKey_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ApiKey" ("availableModels", "baseUrl", "id", "keyData", "notes", "ownerId", "paused", "permanentlyFailed", "providerName", "throttleData") SELECT "availableModels", "baseUrl", "id", "keyData", "notes", "ownerId", "paused", "permanentlyFailed", "providerName", "throttleData" FROM "ApiKey";
DROP TABLE "ApiKey";
ALTER TABLE "new_ApiKey" RENAME TO "ApiKey";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
