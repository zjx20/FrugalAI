# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FrugalAI is a Cloudflare Worker that acts as an API proxy for multiple LLM providers (Google Gemini Code Assist, CodeBuddy, Google AI Studio). It exposes OpenAI-compatible, Gemini-compatible, and Anthropic-compatible API interfaces, enabling free/lower-cost access to Gemini models by internally translating requests to provider-specific formats.

The system uses Cloudflare D1 database (via Prisma ORM) for data persistence, replacing the previous KV-based storage. It supports multi-user management, dual-token authentication (User Tokens and Access Tokens), API key rotation for rate limit handling, and provider-level throttling with exponential backoff.

## Common Commands

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

### Database Management
```bash
# Apply migrations locally (required before first run or after schema changes)
npx wrangler d1 migrations apply <DATABASE_NAME> --local

# Apply migrations to production
npx wrangler d1 migrations apply <DATABASE_NAME> --remote

# Create a new migration file
npx wrangler d1 migrations create <DATABASE_NAME> <migration_name>

# Generate SQL for migration from schema changes
npx prisma migrate diff \
  --from-local-d1 \
  --to-schema-datamodel ./prisma/schema.prisma \
  --script \
  --output ./migrations/<000X_migration_name>.sql
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

## Architecture

### Core Components

- **`src/index.ts`**: Main Cloudflare Worker script (Hono framework), serves as entry point for API routing
- **`src/core/db.ts`**: Data access layer (`Database` class) encapsulating all Prisma operations
- **`src/user.ts`**: Hono app handling user management endpoints (registration, key CRUD, access tokens)
- **`src/admin.ts`**: Hono app for protected admin interface (provider configuration)
- **`prisma/schema.prisma`**: Single source of truth for database schema
- **`public/` directory**: Static assets for UI (automatically served by Cloudflare Workers via `assets` config)
- **`authorize.mjs`**: CLI script for Google OAuth2 flow, outputs Base64 encoded credentials

### Core Request Flow

1. **Request Entry** (`src/index.ts`): Hono router receives requests at `/v1/*` or `/v1beta/*` endpoints
2. **Authentication**: Middleware validates tokens against D1 database:
   - **User Tokens** (`sk-*`): Full access to API and account management
   - **Access Tokens** (`sk-api-*`): API-only, cannot access management endpoints
3. **User Model Alias Resolution** (`resolveUserModelAlias` in `src/index.ts`):
   - Checks if requested model name matches any user-defined alias in `User.modelAliases`
   - If match found, replaces model name with target model(s) from alias mapping
   - Supports all model formats including provider prefixes and comma-separated fallbacks
4. **Model Resolution**: Extracts provider/model/alias from request, supporting formats like:
   - `provider/model` (e.g., `GEMINI_CODE_ASSIST/gemini-2.5-flash`)
   - `model` (auto-selects provider randomly from available providers)
   - `model$alias` (uses provider-configured aliases)
   - Multi-model fallback: `model1,model2,model3` (tries models sequentially until one succeeds)
5. **Key Selection** (`selectKeys` in `src/index.ts`): Filters user's API keys by:
   - Provider compatibility (if provider prefix specified)
   - Protocol support (OpenAI/Gemini/Anthropic)
   - Model availability and per-key eligibility
   - Throttle status (per-key or per-model depending on provider's throttleMode)
   - Sorts by consecutive failure count (prioritizes healthier keys)
6. **Token Refresh**: For providers requiring OAuth (e.g., GEMINI_CODE_ASSIST), refreshes access token if expired
7. **Request Forwarding**: Delegates to provider-specific handler with fleet key rotation
8. **Throttle Management**: Records success/failure and updates exponential backoff state

### Provider System

Each provider implements the `ProviderHandler` interface (`src/core/types.ts`):

- **supportedProtocols()**: Returns supported API protocols (OpenAI, Gemini, Anthropic)
- **canAccessModelWithKey()**: Per-key eligibility check for models (e.g., plan/tier restrictions)
- **handleOpenAIRequest()**: Converts OpenAI format to provider format, forwards request
- **handleGeminiRequest()**: Handles Gemini API format
- **handleAnthropicRequest()**: Handles Anthropic API format

Provider implementations are registered in `src/providers/providers.ts` (`providerHandlerMap`).

### Protocol Adapters

**OpenAI ↔ Gemini** (`src/adapters/openai-gemini.ts`):
- Converts OpenAI chat completion format to Gemini's `contents` format
- Maps roles: `assistant` → `model`, `system` → `systemInstruction`
- Handles tool calls, function calling, streaming (SSE), and usage tracking
- `GeminiToOpenAiSseTransformer`: Transforms streaming responses

**Anthropic ↔ OpenAI** (`src/adapters/anthropic-openai.ts`):
- Similar bidirectional conversion for Anthropic protocol

### Throttle System

**Design** (`src/core/throttle-helper.ts`):
- **BY_KEY mode**: Single global throttle per API key (all models share throttle state)
- **BY_MODEL mode**: Separate throttle per model (independent backoff for each model)
- **Exponential backoff**: Doubles backoff duration on rate limits or 5 consecutive failures
- **Backoff bounds**: Configurable min/max durations per provider (in minutes, converted to ms)
- **In-memory buffering**: Batches throttle updates, commits with at most one DB write per key
- **429 handling**: Can parse `resetTime` from rate limit responses to set precise expiration

**Key interfaces**:
- `ApiKeyFeedback`: Records status updates without immediate DB writes
- `commitPending()`: Persists all buffered changes (call after request completes)

### Database Schema

**Models** (`prisma/schema.prisma`):
- **User**: Has token, name, modelAliases (JSON), owns ApiKeys and AccessTokens
- **AccessToken**: API-only tokens (sk-api-*) for limited access
- **ApiKey**: Stores provider credentials, throttle data, permanent failure flag
- **Provider**: Provider-level config (throttleMode, model list, backoff bounds)

**JSON fields**:
- `User.modelAliases`: User-defined model alias mappings (e.g., `{"gpt-4": "GEMINI_CODE_ASSIST/gemini-2.5-pro,gemini-2.5-flash"}`)
- `ApiKey.keyData`: Provider-specific credential data (Base64 or JSON object)
- `ApiKey.throttleData`: Map of throttle buckets (`{[model]: ThrottleData}` or `{_global_: ThrottleData}`)
- `Provider.models`: Array of model names/aliases (e.g., `["gemini-2.5-flash", "gemini-2.5-pro$alias"]`)

### Dual Token System

**User Tokens (`sk-*`)**: Full-privilege tokens for both API calls and account management
**Access Tokens (`sk-api-*`)**: API-only tokens that cannot perform account management

**Benefits**:
- Organizations can maintain API keys while distributing Access Tokens to members
- Limited privileges prevent Access Token holders from modifying settings
- Individual revocation for fine-grained access control
- Named and timestamped for audit trails

### User Management & Onboarding

**Self-service UI** (`public/user.html`):
1. **Registration**: User registers and receives a User Token (sk-*)
2. **Credential Generation**:
   - **GEMINI_CODE_ASSIST**: Run `node authorize.mjs` to get Base64 encoded OAuth credentials
   - **CODE_BUDDY** (macOS only): Install CLI, login, extract key via `cat "$HOME/Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info" | base64`
   - **GOOGLE_AI_STUDIO**: Get plain text API key from https://aistudio.google.com/api-keys (starts with "AIza...")
3. **API Key Creation**: Login with User Token, select provider, paste credential string
4. **Access Token Creation**: Create API-only tokens (sk-api-*) for limited access
5. **Model Alias Creation** (Optional): Create custom aliases for fixed model names in AI tools

**API endpoints** (`src/user.ts`):
- `POST /api/users` - Register user
- `GET /api/keys` - List API keys
- `POST /api/keys` - Add provider key (accepts Base64 for CODE_ASSIST/CODE_BUDDY, plain text for AI_STUDIO)
- `DELETE /api/keys/:id` - Delete key
- Access token CRUD operations
- `GET /api/user/model-aliases` - Get user's model aliases
- `PUT /api/user/model-aliases` - Create or update model alias (requires `alias` and `models` parameters)
- `DELETE /api/user/model-aliases` - Delete model alias (requires `alias` parameter)

### Admin Interface

**Access**: Protected by password authentication with JWT tokens (24h expiry)

**Security Setup**:
```bash
# Generate password hash
echo -n 'your_admin_password' | shasum -a 256

# Generate JWT secret
openssl rand -base64 32

# Set secrets
npx wrangler secret put ADMIN_PASSWORD_HASH  # paste hex digest
npx wrangler secret put JWT_SECRET           # paste base64 secret
```

**Authentication Flow**:
1. Admin enters password at `/admin.html`
2. Worker hashes password (SHA-256) and compares to `ADMIN_PASSWORD_HASH`
3. If valid, issues JWT signed with `JWT_SECRET` (using `jose` library)
4. Subsequent requests include `Authorization: Bearer <token>`

**API Routes** (`src/admin.ts`):
- `POST /admin/login` - Verify password, return JWT
- `GET /admin/providers` - List providers (requires JWT)
- `PUT /admin/providers/:name` - Update provider config (requires JWT)

**Configuration**: Manage provider models list and throttle settings (min/max duration)

### Token Counting Endpoint

**Endpoint**: `POST /v1/messages/count_tokens`

**Purpose**: Provides token counting functionality for Anthropic-compatible message formats

**Implementation** (`src/index.ts:396-459`):

The endpoint supports two modes:

1. **Proxy Mode** (when `ANTHROPIC_API_KEY` secret is set):
   - Forwards requests to official Anthropic API: `https://api.anthropic.com/v1/messages/count_tokens`
   - Returns accurate token counts from Anthropic's tokenizer
   - Preserves `anthropic-version` and `anthropic-beta` headers

2. **Estimation Mode** (when `ANTHROPIC_API_KEY` is not set):
   - Uses `estimateTokenCount()` function (`src/index.ts:376-471`) for client-side estimation
   - **Text**: ~4 characters per token
   - **Images**: ~1500 tokens per image
   - **PDFs**: Estimates pages from base64 length, ~250 tokens/page (fallback: 2000 tokens)
   - **Tools**: JSON schema length / 3 (accounting for tool overhead)
   - **Tool use/results**: JSON size / 4 for tool use, handles nested content blocks
   - **Extended thinking**: ~4 characters per token (previous turns excluded per API docs)
   - Returns response with `Warning` header: `199 - "Token count is estimated. Set ANTHROPIC_API_KEY secret for accurate counts."`

**Setting the Secret**:
```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

**Response Format**:
```json
{
  "input_tokens": 123
}
```

**Usage**:
- Requires authentication (User Token or Access Token)
- Uses same `jsonBodyParser` and `proxyAuth` middleware as other endpoints
- Gracefully falls back to estimation if API call fails

## Key Implementation Patterns

### Adding a New Provider

1. Create handler class implementing `ProviderHandler` in `src/providers/<provider>/`
2. Implement credential parsing, request forwarding, and response transformation
3. Register in `providerHandlerMap` (`src/providers/providers.ts`)
4. Add provider to `ProviderName` enum in `prisma/schema.prisma`
5. Create migration to add provider to database
6. Configure models and throttle settings via admin interface

### Model Matching Logic

The system matches requested models against configured models using:
- **Exact model match**: Request `model1` matches config `model1` or `model1$alias`
- **Alias match**: Request `alias` matches config `model1$alias`
- **Strict match**: Request `model1$alias` only matches exact config `model1$alias`

Provider prefix filters to specific provider (e.g., `CODE_BUDDY/gemini-2.5-pro`).

### Handling Rate Limits

When a provider returns 429:
1. Handler throws `ThrottledError` with optional `resetTime`
2. `recordModelStatus()` applies exponential backoff to the throttle bucket
3. Key becomes ineligible for that model/global bucket until expiration
4. System tries next available key or falls back to next model in multi-model requests
5. After all attempts exhausted, returns 429 to client with aggregated error details

### Database Migrations

**Always follow this sequence precisely**:

1.  **Edit `prisma/schema.prisma`**: This file is the single source of truth. Make all schema changes here first.

2.  **Generate Migration and Client**: After modifying the schema, generate the SQL migration and regenerate the Prisma client by following these steps:
    *   **Read `wrangler.jsonc`**: Use your `read_file` tool to get the contents of `wrangler.jsonc`.
    *   **Extract `database_name`**: Parse the JSON content in your reasoning process to find the `database_name`. This value is now a known variable for you.
    *   **Create a `migration_name`**: Create a short, descriptive name for the migration (e.g., `add_user_roles`).
    *   **Execute Commands Sequentially**: Run the following commands one by one, substituting the known `<DATABASE_NAME>` and `<migration_name>`.

        1.  Create the migration file:
            ```bash
            npx wrangler d1 migrations create <DATABASE_NAME> <migration_name>
            ```
        2.  Get the latest migration filename:
            ```bash
            ls -t migrations/*.sql | head -n 1
            ```
        3.  Generate the SQL diff (use the filename from the previous step for `<LATEST_MIGRATION_FILE>`):
            ```bash
            npx prisma migrate diff --from-local-d1 --to-schema-datamodel ./prisma/schema.prisma --script --output <LATEST_MIGRATION_FILE>
            ```
        4.  Regenerate the Prisma client:
            ```bash
            npx prisma generate
            ```
    *   If any command fails, stop and report the error.

3.  **Inform the User to Apply Migrations**: **Do not apply migrations automatically.** The user must control when changes are applied. Provide the user with the **fully-formed commands**, replacing the placeholder with the actual `database_name` you extracted.

    *   **Example message to the user (if database name is 'FrugalAI-D1'):**
        > The database migration has been generated successfully.
        >
        > When you are ready, please apply the changes:
        >
        > **For local testing:**
        > ```bash
        > npx wrangler d1 migrations apply FrugalAI-D1 --local
        > ```
        >
        > **For production:**
        > ```bash
        > npx wrangler d1 migrations apply FrugalAI-D1 --remote
        > ```

This workflow ensures migrations are generated correctly and applied safely by the user.

### Streaming Responses

Streaming is handled via SSE (Server-Sent Events):
- OpenAI protocol: Transform Google's SSE format to OpenAI's chunk format
- Use `GeminiToOpenAiSseTransformer` for OpenAI streaming
- Code Assist API wraps responses in `{response: ...}` - unwrap with `CodeAssistUnwrapTransformer`
- Set `stream_options.include_usage: true` to append usage chunk before `[DONE]`

## Configuration Files

- **wrangler.jsonc**: Cloudflare Worker config, D1 database binding, assets directory (public/)
- **prisma/schema.prisma**: Database schema (SQLite for D1)
- **package.json**: Dependencies include Hono (router), Prisma, OpenAI SDK, Google Genai SDK, Anthropic SDK, jose (JWT)

## Important Notes

### Database & Persistence
- Database name in `wrangler.jsonc` is `database_name` not `binding` name
- Use `Database` class (`src/core/db.ts`) for all Prisma operations - instantiated per-request
- Throttle data uses milliseconds internally but provider config uses minutes
- Always call `throttle.commitPending()` after request completes to persist updates

### Authentication & Security
- User tokens (sk-*) provide full access; Access tokens (sk-api-*) are API-only
- Never store plaintext passwords; use SHA-256 hash in `ADMIN_PASSWORD_HASH` secret
- JWT tokens expire after 24 hours
- GOOGLE_AI_STUDIO uses plain text API keys; other providers use Base64 encoded credentials

### Provider Implementation
- Provider handlers must not perform network calls in `canAccessModelWithKey()` - it's a synchronous eligibility check
- Permanent failures (`permanentlyFailed` flag) skip keys entirely in selection logic
- Model format supports provider prefix, model name, and alias: `[provider/]model[$alias]`
- Provider selection is random when no prefix specified; explicit when prefix used

### Static Assets
- `public/` directory is automatically served by Cloudflare Workers via `assets` binding
- No manual routing needed in `src/index.ts` for static files
- Example: Request to `/user.html` serves `public/user.html`
