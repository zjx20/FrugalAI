-- Migration number: 0002 	 2025-07-12T14:59:08.480Z
INSERT INTO "Provider" ("name", "throttleMode", "models") VALUES (
	'GEMINI_CODE_ASSIST',
	'BY_MODEL',
	'["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]'
);
