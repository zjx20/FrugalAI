# Project Context for Gemini Agent

This document provides essential context about the "Gemini Free API Proxy" project for the Gemini CLI Agent. It outlines the project's architecture, functionality, and key workflows to guide the agent in understanding and modifying the codebase.

## 1. Project Overview

This project is a Cloudflare Worker that acts as a proxy to the Google Gemini API. It exposes a public API endpoint that is compatible with the official Google GenAI API specification. Internally, it translates incoming requests to the format required by the Google Code Assist API, effectively enabling free access to Gemini models.

The project has been refactored to use a **Cloudflare D1 database** via the **Prisma ORM** for data persistence, replacing the previous KV-based storage for user and key management. It provides a self-service web UI for users to register and manage their API keys.

## 2. Core Components

-   **`src/index.ts`**: The main Cloudflare Worker script, built with Hono. It serves as the main entry point, routing API traffic and serving the user management UI.
-   **`src/db.ts`**: A data access layer class (`Database`) that encapsulates all Prisma database operations. It is instantiated per-request with a `PrismaClient` instance to ensure compatibility with the Cloudflare Workers environment.
-   **`src/user.ts`**: A Hono application that handles all user management API endpoints (e.g., `/api/user/register`, `/api/user/keys`). It is mounted as a route in `src/index.ts`.
-   **`prisma/schema.prisma`**: The single source of truth for the database schema. It defines all models (User, ApiKey, Provider), fields, and relations.
-   **`public/user.html` & `public/user.js`**: A simple frontend for user self-service (registration, API key management). The HTML is served from `src/index.ts`, and the JavaScript communicates with the backend API.
-   **`authorize.mjs`**: A command-line Node.js script that guides the user through the Google OAuth2 flow for the original proxy functionality.
-   **`wrangler.jsonc`**: The configuration file for the Cloudflare Worker, including bindings for the KV namespace and the D1 database.

## 3. Key Workflows

### 3.1. User Self-Service Management (New)

A web interface is available for users to manage their accounts without using the CLI.

1.  The user navigates to the root URL of the worker.
2.  `src/index.ts` serves the user management page (`public/user.html`) and its assets.
3.  The frontend (`public/user.js`) communicates with the API endpoints exposed by `src/user.ts` (mounted under `/api`) to handle:
    -   **Registration**: Creates a new user in the D1 database and returns a user-specific API token (`sk-...`).
    -   **API Key Management**: Allows authenticated users (using the Bearer token) to perform CRUD operations on their API keys for various providers.

### 3.2. Original Authorization and API Key Generation

The process for a user to obtain an API key for the core proxy functionality remains.

1.  The user runs the Cloudflare Worker, either locally (`npm run dev`) or by deploying it (`npm run deploy`), to get a service **Endpoint URL**.
2.  The user runs the `authorize.mjs` script from their terminal, providing the endpoint URL.
3.  The script handles the OAuth2 consent flow, receives authorization tokens, and communicates with the worker to register or update credentials in KV. The final API key is printed to the user's console.

### 3.3. API Request Flow (Core Proxy)

1.  A user makes a request to the proxy endpoint (e.g., `/v1beta/models/gemini-2.5-flash:generateContent`), providing their API key.
2.  The worker retrieves credentials from KV using the API key.
3.  The worker refreshes the `access_token` if necessary.
4.  The worker forwards the request to the internal Google Code Assist API, handling fleet key rotation and rate-limiting logic.
5.  The response is translated back to the standard Gemini API format and returned to the user.

## 4. Database Development Workflow (Prisma & D1)

This section details the correct, multi-step process for modifying the database schema, which is crucial for the agent to follow.

#### Step 1: Modify `prisma/schema.prisma`

This file is the single source of truth for database models. Make all schema changes here.

#### Step 2: Create an Empty Migration File

Use Wrangler to create the migration folder and empty `.sql` file.

```bash
npx wrangler d1 migrations create <YOUR_DATABASE_NAME> <your_migration_name>
```
-   `<YOUR_DATABASE_NAME>` is the binding name in `wrangler.jsonc`.
-   `<your_migration_name>` should be descriptive (e.g., `add_apikey_notes`).

#### Step 3: Generate SQL Diff

Use Prisma to generate the SQL commands by comparing the local D1 database state with the updated schema. The output must be piped into the file created in the previous step.

```bash
npx prisma migrate diff \
  --from-local-d1 \
  --to-schema-datamodel ./prisma/schema.prisma \
  --script \
  --output ./migrations/<000X_your_migration_name>/migration.sql
```
-   The agent must replace the `--output` path with the correct, newly generated migration file path.

#### Step 4: Apply Migration to Local DB & Regenerate Client

Apply the migration to the local D1 instance to keep it synchronized. **This step is critical** for future `diff` operations.

```bash
npx wrangler d1 migrations apply <YOUR_DATABASE_NAME> --local
```

After applying the migration, regenerate the Prisma Client to update its types.

```bash
npx prisma generate
```

#### Step 5: Apply Migration to Production DB

After local testing is complete, apply the migration to the production D1 database.

```bash
npx wrangler d1 migrations apply <YOUR_DATABASE_NAME> --remote
```

This workflow ensures that schema changes are version-controlled and applied consistently across all environments.

## 5. Agent Guidelines

This section outlines the operational guidelines for the Gemini CLI Agent when interacting with this project.

1.  **Plan Before Action:** Before making any code modifications, always provide a clear plan of the proposed changes to the user. Proceed with implementation only after receiving explicit confirmation from the user.
2.  **Language Consistency:** Respond to the user in the language they used for their query. However, all code comments within the project must be written in English.
