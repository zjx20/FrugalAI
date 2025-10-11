-- Migration number: 0006 	 2025-10-09T13:57:00.000Z
INSERT INTO "Provider" ("name", "throttleMode", "models") VALUES (
	'GOOGLE_AI_STUDIO',
	'BY_MODEL',
	'["gemini-2.5-pro", "gemini-flash-latest", "gemini-flash-lite-latest"]'
);
