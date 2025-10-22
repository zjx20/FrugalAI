# FrugalAI Project Context for AI Agents

This document provides a comprehensive overview of the FrugalAI project, designed to be used as a primary context source for AI programming assistants. It details the project's architecture, core business logic, key workflows, and operational guidelines.

## 1. Project Overview

FrugalAI is a powerful and flexible LLM API gateway deployed as a Cloudflare Worker. Its primary goal is to provide a unified, reliable, and feature-rich interface for various large language model providers. It abstracts away the complexity of managing multiple API keys and different provider-specific APIs, exposing a consistent set of endpoints compatible with popular standards like OpenAI, Google Gemini, and Anthropic.

The system uses a Cloudflare D1 database (via Prisma ORM) for data persistence. It supports multi-user management, a dual-token authentication system, API key rotation for rate limit handling, and provider-level throttling with exponential backoff.

**Key Features:**
- **Multi-Provider Support**: Seamlessly integrate with `GEMINI_CODE_ASSIST`, `CODE_BUDDY`, `GOOGLE_AI_STUDIO`, and any `OPEN_AI`-compatible service.
- **Unified API Interface**: Exposes OpenAI, Google Gemini, and Anthropic-compatible endpoints.
- **API Key Pooling & Rotation**: Manages multiple API keys per provider, enabling automatic rotation to handle rate limits.
- **Multi-Model Fallback**: Supports a sequence of models in a single request (e.g., `gemini-2.5-pro,gemini-2.5-flash`) for automatic fallback.
- **Advanced Routing**: Allows provider-specific model selection (e.g., `GEMINI_CODE_ASSIST/gemini-2.5-flash`).
- **Custom Model Aliases**: Users can create custom aliases for model names to ensure compatibility with various tools.
- **Secure Dual-Token System**: Differentiates between full-access **User Tokens** (`sk-...`) for management and API-only **Access Tokens** (`sk-api-...`) for application integration.

## 2. Common Commands

### Development
```bash
# Install dependencies
npm install

# Generate Prisma client (required after schema changes)
npx prisma generate

# Start local development server (runs on http://localhost:8787)
npm run dev

# Run tests
npm test
```

### Deployment
```bash
# Deploy to Cloudflare
npm run deploy

# Set secrets (run interactively)
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put JWT_SECRET
npx wrangler secret put ANTHROPIC_API_KEY  # Optional, for accurate token counting
```

## 3. Architecture & Core Components

-   **`src/index.ts`**: The main Cloudflare Worker script (Hono framework). It serves as the main entry point, routing all API traffic and handling core logic.
-   **`src/core/db.ts`**: A data access layer class (`Database`) that encapsulates all Prisma database operations. It is instantiated per-request.
-   **`src/user.ts`**: A Hono application for all user management API endpoints (registration, key management, access tokens, model aliases).
-   **`src/admin.ts`**: A Hono application for the protected administrator interface (provider configuration).
-   **`prisma/schema.prisma`**: The single source of truth for the database schema.
-   **`public/` directory**: Contains all static assets for the user-facing UI, served automatically by Cloudflare Workers via the `assets` binding in `wrangler.jsonc`.
-   **`authorize.mjs`**: A standalone CLI script to guide users through the Google OAuth2 flow for `GEMINI_CODE_ASSIST` credentials.
-   **`src/providers/`**: Directory containing individual provider handlers, each implementing the `ProviderHandler` interface.
-   **`src/adapters/`**: Contains logic for converting between different API protocols (e.g., `openai-gemini.ts`, `anthropic-openai.ts`).

## 4. Key Workflows & Business Logic

### 4.1. API Request Flow (Core Logic)

The core logic of the gateway follows a sophisticated pipeline:

1.  **Authentication**: The `bearerAuth` middleware in `src/index.ts` validates the `Authorization: Bearer <token>`. It distinguishes between User Tokens and Access Tokens to enforce permissions and fetches the user's data, keys, and aliases from the database.

2.  **Model Resolution**: The system determines the target model(s) in a multi-step process:
    a.  **User-Defined Alias Resolution**: The system first checks if the requested model name matches a user-defined alias. If so, the alias is replaced with its corresponding target model string (e.g., `"gpt-4"` becomes `"GEMINI_CODE_ASSIST/gemini-2.5-pro,gemini-2.5-flash"`).
    b.  **Multi-Model Fallback Parsing**: The resulting model string is parsed for commas to create a sequential list of models for fallback.
    c.  **Provider/Model Extraction**: For each model in the sequence, the system separates the provider prefix, the base model name, and any provider-defined alias suffix.

3.  **Sequential Fallback Execution**: The system iterates through the fallback list of models. For each model:
    a.  **Key Selection Logic**: The system filters the user's API keys to find suitable candidates. A key is considered suitable if it matches the provider (if specified), supports the requested model, and is not currently throttled or marked as permanently failed. Eligible keys are then sorted by health to prioritize those with fewer consecutive failures.
    b.  **Request Attempt**: Forwards the request using a suitable key, handling token refreshes if necessary.
    c.  **Success or Continue**: If successful, the response is translated back to the original request format and returned. If it fails (e.g., rate limit), it tries the next available key for the *same model*. If all keys for the current model fail, it moves to the *next model* in the fallback sequence.

4.  **Final Failure**: If all models in the sequence fail, a final error is returned.

### 4.2. User Management & Onboarding

- **Self-Service UI** (`public/user.html`): Users manage their accounts, API keys, access tokens, and model aliases.
- **Per-Key Model Management**: The UI allows users to customize the list of available models for each API key. They can exclude models from the provider's default list or add custom models.
- **Dual-Token System**:
    - **User Tokens (`sk-...`)**: Full privileges for API calls and account management.
    - **Access Tokens (`sk-api-...`)**: API-only access, ideal for applications. They cannot modify account settings.
- **Onboarding**:
    1.  **Registration**: User registers via UI to get a User Token.
    2.  **Credential Generation**: User obtains credentials from providers (e.g., `node authorize.mjs` for `GEMINI_CODE_ASSIST`, web UI for `GOOGLE_AI_STUDIO`).
    3.  **API Key Creation**: User adds credentials as API keys in the UI. For `OPEN_AI` provider, `baseUrl` and `availableModels` can be specified.

### 4.3. Administrator Interface

- **Access**: A separate `/admin.html` interface allows administrators to configure provider-level settings (e.g., model lists, throttle parameters).
- **Security**: Protected by a password hash (`ADMIN_PASSWORD_HASH`) and a JWT signing key (`JWT_SECRET`) stored as Cloudflare Worker secrets. Login issues a short-lived JWT.

### 4.4. Database Schema (`prisma/schema.prisma`)

- **Models**:
    - **User**: Stores user info, owns `ApiKey`s and `AccessToken`s.
    - **AccessToken**: API-only tokens (`sk-api-...`).
    - **ApiKey**: Stores provider credentials, throttle data, `permanentlyFailed` flag, and optional `baseUrl` and `availableModels`.
    - **Provider**: Stores provider-level configuration like `throttleMode` and `models`.
- **JSON Fields**:
    - `User.modelAliases`: User-defined model alias mappings.
    - `ApiKey.keyData`: Provider-specific credential data.
    - `ApiKey.throttleData`: Stores throttle state for the key.
    - `ApiKey.availableModels`: A JSON array that modifies the provider's default model list for a specific key. It supports two types of entries:
        - **Addition**: A model name string (e.g., `"my-custom-model"`) adds a model to the list.
        - **Exclusion**: A model name string prefixed with a hyphen (e.g., `"-gpt-4-turbo"`) removes that model from the provider's default list.
        If this field is `null` or empty, the key defaults to using the provider's `models` list.
    - `Provider.models`: Default list of model names/aliases for a provider.

### 4.5. Throttle System (`src/core/throttle-helper.ts`)

- **Modes**: `BY_KEY` (global throttle per key) and `BY_MODEL` (separate throttle per model within a key).
- **Logic**: Uses exponential backoff on rate limits or consecutive failures.
- **State Management**: Throttle state is buffered in memory during the request. All pending changes are committed to the database in a single batch operation at the end of the request to minimize database writes.

## 5. Database Development & Migrations (CRITICAL AGENT GUIDELINE)

**You must follow these steps precisely to avoid corrupting the database or migrations.**

1.  **Step 1: Modify `prisma/schema.prisma`**
    This file is the single source of truth. Make all schema changes here first.

2.  **Step 2: Generate Migration Files and Client**
    This is a multi-command process. Execute each command carefully and sequentially.

    a.  **Identify `database_name`**: First, use the `read_file` tool to read `wrangler.jsonc`. In your reasoning, parse the JSON to find the `database_name` from the `d1_databases` array. This value is now a known variable.

    b.  **Create a Descriptive `migration_name`**: Based on the schema changes, create a short, descriptive name (e.g., `add_notes_to_apikey`).

    c.  **Execute Migration Generation Commands**: Execute the following commands sequentially, substituting the actual `<DATABASE_NAME>` and `<migration_name>`.

        i. **Regenerate the Prisma client:**
            ```bash
            npx prisma generate
            ```

        ii.  **Create the migration file:**
            ```bash
            npx wrangler d1 migrations create <DATABASE_NAME> <migration_name>
            ```

        iii. **Get the latest migration filename:**
            ```bash
            ls -t migrations/*.sql | head -n 1
            ```
            The output of this command is the filename for the next step.

        iv. **Generate the SQL diff:**
            ```bash
            npx prisma migrate diff --from-local-d1 --to-schema-datamodel ./prisma/schema.prisma --script --output <LATEST_MIGRATION_FILE>
            ```

    *If any command fails, stop immediately and report the error.*

3.  **Step 3: Inform the User to Apply Migrations**
    **Do not apply migrations automatically.** The user must control this. Provide the user with the **fully-formed commands**, replacing the placeholder with the actual `database_name` you extracted.

    **Example Message to User (if database name is 'FrugalAI-D1'):**
    > The database migration has been generated successfully. When you are ready, please apply the changes:
    > **For local testing:**
    > ```bash
    > npx wrangler d1 migrations apply FrugalAI-D1 --local
    > ```
    > **For production:**
    > ```bash
    > npx wrangler d1 migrations apply FrugalAI-D1 --remote
    > ```

## 6. Key Implementation Patterns & Agent Tips

- **Adding a New Provider**:
    1. Create a handler class in `src/providers/<provider>/` implementing `ProviderHandler`.
    2. Implement credential parsing, request forwarding, and response transformation.
    3. Register it in `providerHandlerMap` in `src/providers/providers.ts`.
    4. Add the provider to the `ProviderName` enum in `prisma/schema.prisma` and create/run a database migration.

- **Model Matching Logic**: The system uses a flexible matching logic:
    - **Exact Match**: `model1` matches config `model1` or `model1$alias`.
    - **Alias Match**: `alias` matches config `model1$alias`.
    - **Strict Match**: `model1$alias` only matches config `model1$alias`.
    - A provider prefix (e.g., `CODE_BUDDY/`) filters keys to that specific provider.

- **Important Notes**:
    - **DB Access**: Always use the `Database` class (`src/core/db.ts`) for Prisma operations.
    - **Static Assets**: The `public/` directory is served automatically. No routing logic is needed in `src/index.ts` for these files.
    - **Language**: Respond to users in their language. But all code, comments, and commit messages must be in **English**.
    - **Plan First**: Always outline your plan before modifying code and wait for user confirmation.
    - **Documentation Update**: If a new feature is complex or significant, please update this `AGENTS.md` file after implementation.
