# Project Context for Gemini Agent

This document provides essential context about the "FrugalAI" project for the Gemini CLI Agent. It outlines the project's architecture, functionality, and key workflows to guide the agent in understanding and modifying the codebase.

## 1. Project Overview

This project is a Cloudflare Worker that acts as a proxy to the Google Gemini API. It exposes a public API endpoint that is compatible with the official Google GenAI API specification. Internally, it translates incoming requests to the format required by the Google Code Assist API, effectively enabling free access to Gemini models.

The project has been refactored to use a **Cloudflare D1 database** via the **Prisma ORM** for data persistence, replacing the previous KV-based storage for user and key management. It provides a self-service web UI for users to register and manage their API keys.

## 2. Core Components

-   **`src/index.ts`**: The main Cloudflare Worker script, built with Hono. It serves as the main entry point, routing API traffic and serving the user management UI.
-   **`src/db.ts`**: A data access layer class (`Database`) that encapsulates all Prisma database operations. It is instantiated per-request with a `PrismaClient` instance to ensure compatibility with the Cloudflare Workers environment.
-   **`src/user.ts`**: A Hono application that handles all user management API endpoints (e.g., `/api/user/register`, `/api/user/keys`). It is mounted as a route in `src/index.ts`.
-   **`prisma/schema.prisma`**: The single source of truth for the database schema. It defines all models (User, ApiKey, Provider), fields, and relations.
-   **`public/` directory**: Contains all static assets for the user-facing UI.
    -   **Important**: This directory is automatically served by Cloudflare Workers. The `"assets"` configuration in `wrangler.jsonc` maps the `/` route of the deployed worker to this directory. For example, a request to `https://your-worker-url/user.html` will serve the `public/user.html` file. No manual routing logic in `src/index.ts` is needed for these files.
-   **`authorize.mjs`**: A simplified command-line script. Its sole purpose is to guide a user through the Google OAuth2 flow and output a Base64 encoded credential string. It no longer communicates with the worker API.
-   **`wrangler.jsonc`**: The configuration file for the Cloudflare Worker, including bindings for the KV namespace, the D1 database, and the static `assets` directory.

## 3. Key Workflows

### 3.1. User and API Key Onboarding

The new workflow is entirely centered around the web UI and supports multiple providers.

1.  **User Registration**: A new user navigates to the worker's `/user.html` page, registers, and receives a persistent User Token (`sk-...`).
2.  **Provider Credential Generation**: Users can obtain credentials for different providers:
    -   **`GEMINI_CODE_ASSIST`**: Run `node authorize.mjs` to handle the Google OAuth flow and output a Base64 encoded credential string.
    -   **`CODE_BUDDY`**: Install the CodeBuddy CLI tool from https://www.codebuddy.ai/cli, complete the login process, then extract the authentication key using: `cat "$HOME/Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info" | base64` (macOS only; other systems TBD).
3.  **API Key Creation**: The user logs into the web UI with their User Token, selects the appropriate provider (`GEMINI_CODE_ASSIST` or `CODE_BUDDY`), and pastes the Base64 string from the previous step into the "key" field to create a new `ApiKey` record in the database.

### 3.2. API Request Flow (Core Proxy)

1.  A user makes a request to a `/v1/...` endpoint, providing their User Token in the `Authorization: Bearer <token>` header.
2.  The `bearerAuth` middleware in `src/index.ts` validates the token and retrieves the user object, including all associated API keys, from the database.
3.  The endpoint logic filters for usable keys belonging to the appropriate provider (e.g., `GEMINI_CODE_ASSIST` or `CODE_BUDDY`) based on the request (i.e., not rate-limited or permanently failed).
4.  The worker refreshes the `access_token` if necessary (for providers that require token refresh).
5.  The worker forwards the request to the corresponding provider's API, handling fleet key rotation and rate-limiting logic.
6.  The response is translated back to the standard Gemini API format and returned to the user.

## 4. Database Development Workflow (Prisma & D1)

This section details the correct, multi-step process for modifying the database schema, which is crucial for the agent to follow.

#### Step 1: Modify `prisma/schema.prisma`

This file is the single source of truth for database models. Make all schema changes here.

#### Step 2: Create an Empty Migration File

Use Wrangler to create the migration folder and empty `.sql` file.

```bash
npx wrangler d1 migrations create <YOUR_DATABASE_NAME> <your_migration_name>
```
-   `<YOUR_DATABASE_NAME>` is the `database_name` from `wrangler.jsonc`.
-   `<your_migration_name>` should be descriptive (e.g., `add_apikey_notes`).

#### Step 3: Generate SQL Diff

Use Prisma to generate the SQL commands by comparing the local D1 database state with the updated schema. The output must be piped into the file created in the previous step.

```bash
npx prisma migrate diff \
  --from-local-d1 \
  --to-schema-datamodel ./prisma/schema.prisma \
  --script \
  --output ./migrations/<000X_your_migration_name>.sql
```
-   The agent must replace the `--output` path with the correct, newly generated migration file path.

#### Step 4: Apply Migration to Local DB & Regenerate Client

Apply the migration to the local D1 instance to keep it synchronized. **This step is critical** for future `diff` operations.

```bash
npx wrangler d1 migrations apply <YOUR_DATABASE_NAME> --local
```
-   `<YOUR_DATABASE_NAME>` is the `database_name` from `wrangler.jsonc`.

After applying the migration, regenerate the Prisma Client to update its types.

```bash
npx prisma generate
```

#### Step 5: Apply Migration to Production DB

After local testing is complete, apply the migration to the production D1 database.

```bash
npx wrangler d1 migrations apply <YOUR_DATABASE_NAME> --remote
```
-   `<YOUR_DATABASE_NAME>` is the `database_name` from `wrangler.jsonc`.

This workflow ensures that schema changes are version-controlled and applied consistently across all environments.

## 5. Administrator Interface

This project provides an admin interface to manage provider configurations (models and throttle settings) without touching the database directly.

- Admin Login Flow:
  - The admin enters a password on `/admin.html`.
  - The worker hashes the password with Web Crypto (SHA-256) and compares it to `ADMIN_PASSWORD_HASH` stored as a secret.
  - If valid, the worker issues a short-lived JWT (24h) signed with HMAC using `JWT_SECRET` via the `jose` library.
  - Subsequent admin API calls include `Authorization: Bearer <token>`.

- Where the admin password is stored:
  - Do NOT store plaintext anywhere.
  - Only store the SHA-256 hex hash of the password as a Cloudflare Worker secret named `ADMIN_PASSWORD_HASH`.
  - Store the JWT signing key as a Cloudflare Worker secret named `JWT_SECRET`.

- Relevant files:
  - `src/admin.ts`: Hono app with routes:
    - `POST /admin/login` — verifies password hash and returns a JWT.
    - `GET /admin/providers` — lists providers (requires JWT).
    - `PUT /admin/providers/:name` — updates provider config (requires JWT).
  - `public/admin.html`: Admin UI. Handles login, token storage, fetching and updating provider configs.

- Environment configuration (Cloudflare):
  - Use Wrangler (or Dashboard) to set secrets:
    - `npx wrangler secret put ADMIN_PASSWORD_HASH`
    - `npx wrangler secret put JWT_SECRET`
  - To generate hash:
    - `echo -n "your_admin_password" | shasum -a 256` (copy the hex digest)
  - To generate JWT secret:
    - `openssl rand -base64 32`

- Security notes:
  - Do not put plaintext passwords in code or config.
  - Prefer short JWT lifetimes (24h or shorter).
  - Consider additional hardening (IP allowlist, TOTP, session versioning in KV/D1) if needed.

## 5. Agent Guidelines

This section outlines the operational guidelines for the Gemini CLI Agent when interacting with this project.

1.  **Plan Before Action:** Before making any code modifications, always provide a clear plan of the proposed changes to the user. Proceed with implementation only after receiving explicit confirmation from the user.
2.  **Language Consistency:** Respond to the user in the language they used for their query. However, all code comments within the project must be written in English.
