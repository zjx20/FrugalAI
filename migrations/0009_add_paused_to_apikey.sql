-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ApiKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "providerName" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "keyData" JSONB NOT NULL,
    "throttleData" JSONB NOT NULL,
    "notes" TEXT,
    "permanentlyFailed" BOOLEAN NOT NULL DEFAULT false,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ApiKey_providerName_fkey" FOREIGN KEY ("providerName") REFERENCES "Provider" ("name") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApiKey_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ApiKey" ("id", "keyData", "notes", "ownerId", "permanentlyFailed", "providerName", "throttleData") SELECT "id", "keyData", "notes", "ownerId", "permanentlyFailed", "providerName", "throttleData" FROM "ApiKey";
DROP TABLE "ApiKey";
ALTER TABLE "new_ApiKey" RENAME TO "ApiKey";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
