-- AlterTable
ALTER TABLE "Provider" ADD COLUMN "displayName" TEXT;

-- Update existing providers with display names
UPDATE "Provider" SET "displayName" = 'Gemini Code Assist' WHERE "name" = 'GEMINI_CODE_ASSIST';
UPDATE "Provider" SET "displayName" = 'CodeBuddy' WHERE "name" = 'CODE_BUDDY';
UPDATE "Provider" SET "displayName" = 'Google AI Studio' WHERE "name" = 'GOOGLE_AI_STUDIO';
UPDATE "Provider" SET "displayName" = 'OpenAI Compatible' WHERE "name" = 'OPEN_AI';
