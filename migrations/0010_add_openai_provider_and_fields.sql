-- AlterTable: Add new fields to ApiKey
ALTER TABLE "ApiKey" ADD COLUMN "availableModels" JSONB;
ALTER TABLE "ApiKey" ADD COLUMN "baseUrl" TEXT;

-- Insert OPEN_AI provider
INSERT INTO "Provider" ("name", "throttleMode", "minThrottleDuration", "maxThrottleDuration", "models")
VALUES ('OPEN_AI', 'BY_KEY', 1, 15, '[]');
