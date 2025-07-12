-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token" TEXT NOT NULL,
    "name" TEXT
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "providerName" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "keyData" JSONB NOT NULL,
    "throttleData" JSONB NOT NULL,
    CONSTRAINT "ApiKey_providerName_fkey" FOREIGN KEY ("providerName") REFERENCES "Provider" ("name") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApiKey_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Provider" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "throttleMode" TEXT NOT NULL DEFAULT 'BY_KEY',
    "minThrottleDuration" INTEGER NOT NULL DEFAULT 1,
    "maxThrottleDuration" INTEGER NOT NULL DEFAULT 15,
    "models" JSONB NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_token_key" ON "User"("token");
