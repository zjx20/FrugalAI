-- Migration number: 0005 	 2025-09-20T20:43:08.480Z
INSERT INTO "Provider" ("name", "throttleMode", "models") VALUES (
	'CODE_BUDDY',
	'BY_KEY',
	'["claude-4.0", "gemini-2.5-flash", "gemini-2.5-pro", "gpt-5", "gpt-5-mini", "gpt-5-nano", "o4-mini", "deepseek-v3-1-lkeap", "deepseek-v3-0324-lkeap", "deepseek-r1-0528-lkeap"]'
);
