-- AlterTable
ALTER TABLE "Provider" ADD COLUMN "nativeProtocols" JSONB;

-- Set default nativeProtocols for existing providers
UPDATE "Provider" SET "nativeProtocols" = '["gemini"]' WHERE "name" = 'GOOGLE_AI_STUDIO';
UPDATE "Provider" SET "nativeProtocols" = '["gemini"]' WHERE "name" = 'GEMINI_CODE_ASSIST';
UPDATE "Provider" SET "nativeProtocols" = '["openai"]' WHERE "name" = 'CODE_BUDDY';
UPDATE "Provider" SET "nativeProtocols" = '["openai"]' WHERE "name" = 'OPEN_AI';

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "name" TEXT,
    "modelSettings" JSONB
);
INSERT INTO "new_User" ("id", "name", "token") SELECT "id", "name", "token" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_token_key" ON "User"("token");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
