# FrugalAI

The solution for the poor, long live free access!

FrugalAI is a powerful and flexible LLM API gateway, designed to provide a unified interface for various large language model providers. Deployed as a Cloudflare Worker, it offers a robust solution for managing API keys, routing requests, and enhancing reliability, all while maintaining compatibility with the API standard of OpenAI, Google Gemini, and Anthropic.

This project uses a Cloudflare D1 database to store user and API key information, and provides a web interface for management. Key features include:

- **Multi-Provider Support**: Seamlessly integrate with various LLM providers such as `GEMINI_CODE_ASSIST`, `CODE_BUDDY`, `GOOGLE_AI_STUDIO`, and any `OPEN_AI`-compatible service.
- **Unified API Interface**: Exposes OpenAI, Google Gemini, and Anthropic-compatible endpoints, allowing you to use your favorite tools and applications without modification.
- **API Key Pooling**: Manage multiple API keys per provider for a single user, enabling automatic rotation to handle rate limits and improve uptime.
- **Multi-Model Fallback**: Specify a sequence of models in a single request (e.g., `gemini-2.5-pro,gemini-2.5-flash`) for automatic fallback if the primary model is unavailable.
- **Advanced Routing**: Precisely control which provider to use with provider-specific model names (e.g., `GEMINI_CODE_ASSIST/gemini-2.5-flash`).
- **Custom Model Aliases**: Create custom aliases for model names to ensure compatibility with tools that have hard-coded model identifiers.
- **Secure Token System**: Differentiates between full-access User Tokens (`sk-...`) for management and API-only Access Tokens (`sk-api-...`) for safer application integration.

## Deployment and Operation

You can run this project either in a local development mode or by deploying it directly to Cloudflare. In either case, you will get an **Endpoint URL**, which is the access address for your service.

### 1. Prerequisites

Before you begin, ensure you have the following:

-   [Node.js](https://nodejs.org/) (v20.x or later recommended)
-   An active [Cloudflare account](https://dash.cloudflare.com/sign-up)
-   A configured Cloudflare D1 database.

### 2. Installation and Configuration

First, clone the repository and install the dependencies:

```bash
git clone https://github.com/zjx20/FrugalAI.git
cd FrugalAI
npm install

npx prisma generate
```

Next, open the `wrangler.jsonc` file and configure your D1 database binding with the appropriate ID from your Cloudflare dashboard.

### 3. Run the Project

**Important: Database Migrations**

Before running or deploying the project for the first time, or after any database schema changes, you must apply the D1 database migrations. This ensures your database schema is up-to-date.

To apply migrations, use the following command, replacing `<YOUR_DATABASE_NAME>` with the `database_name` (not the `binding` name) from your `wrangler.jsonc` file:

```bash
npx wrangler d1 migrations apply <YOUR_DATABASE_NAME> --local # For local development
npx wrangler d1 migrations apply <YOUR_DATABASE_NAME> --remote # For deployment
```

For more details on database development and migrations, refer to the "Database Development with Prisma and Cloudflare D1" section below.

**Local Development Mode:**

Run the following command to start the local development server:

```bash
npm run dev
```

After the server starts, your **Endpoint URL** will typically be `http://localhost:8787`.

**Deploying to Cloudflare:**

Run the following command to deploy the project to Cloudflare:

```bash
npm run deploy
```

Upon successful deployment, Cloudflare will provide you with a public **Endpoint URL** (e.g., `https://your-worker-name.your-subdomain.workers.dev`).

### 4. (Optional) Configuring Secrets

This project uses Cloudflare Worker secrets for sensitive configuration. Secrets are optional but enable additional features. You can configure them through the Cloudflare dashboard or via Wrangler CLI.

#### Available Secrets

**1. `ADMIN_PASSWORD_HASH` (Optional - For Admin Interface)**

Enables the administrator interface at `/admin.html` for managing provider configurations (models list, throttle settings).

- **Purpose**: Password authentication for admin panel
- **How to generate**: Create a SHA-256 hash of your desired admin password:
  ```bash
  echo -n 'your_admin_password' | shasum -a 256
  ```
- **Required with**: `JWT_SECRET` (both needed for admin access)

**2. `JWT_SECRET` (Optional - For Admin Interface)**

Used to sign and verify JWT tokens for admin session management.

- **Purpose**: Secure token signing for admin authentication (24-hour expiry)
- **How to generate**: Create a secure random string:
  ```bash
  openssl rand -base64 32
  ```
- **Required with**: `ADMIN_PASSWORD_HASH` (both needed for admin access)

**3. `ANTHROPIC_API_KEY` (Optional - For Token Counting)**

Enables accurate token counting for the `/v1/messages/count_tokens` endpoint.

- **Purpose**: Provides precise token counts via official Anthropic API
- **Behavior when not set**: Endpoint returns estimated token counts with a warning header
- **How to obtain**:
  1. Visit https://console.anthropic.com/ and sign in
  2. Navigate to API Keys section
  3. Create a new API key
  4. Copy the key (starts with "sk-ant-")
- **Cost**: Token counting via Anthropic API is free but subject to rate limits

#### Setting Secrets

**Via Cloudflare Dashboard:**

Go to your Worker's **Settings > Variables** and add secrets under **Environment Variables**.

**Via Wrangler CLI:**

Run the following commands and paste the secret value when prompted:

```bash
# For admin interface (both required)
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put JWT_SECRET

# For accurate token counting (optional)
npx wrangler secret put ANTHROPIC_API_KEY
```

#### Accessing the Admin Interface

Once `ADMIN_PASSWORD_HASH` and `JWT_SECRET` are configured, access the admin panel at `/admin.html` on your worker's URL (e.g., `https://your-worker-name.your-subdomain.workers.dev/admin.html`).

## User and API Key Management

This project uses a self-service web UI to manage users and their API keys. A single user can manage multiple API keys from different providers, allowing the proxy to rotate through them to handle rate limits.

### API Key Types

The system supports two types of API keys:

1. **User Tokens** (Full Access): These tokens (prefixed with `sk-`) provide full access to both the LLM API and account management features. They can create, edit, and delete API keys, as well as manage access tokens.

2. **Access Tokens** (API-Only): These tokens (prefixed with `sk-api-`) can only call the LLM API and cannot access account management features. They are safer to share or use in applications where you don't want to grant full account access.

## User Registration and API Key Setup

### Step 1: Register and Get Your User Token

First, you need a personal User Token to access the management interface and the API.

1.  Navigate to the user management page by opening `/user.html` on your deployed worker's URL (e.g., `https://your-worker-name.your-subdomain.workers.dev/user.html`).
2.  On the management page, click the "Register here" link.
3.  Optionally enter a name and click "Register".
4.  The page will display your unique **User Token** (prefixed with `sk-`). **Save this token securely**, as it is your API key for all subsequent operations.

### Step 2: Obtain Credentials for Providers

The proxy supports multiple providers. You can obtain credentials for the following providers:

#### `GEMINI_CODE_ASSIST` Provider

The core proxy functionality relies on API keys for the `GEMINI_CODE_ASSIST` provider. To generate the necessary credentials from a Google account, run the `authorize.mjs` script from your terminal:

```bash
node authorize.mjs
```

This script will:
1.  Open a Google authorization page in your browser.
2.  Guide you through the login and consent process.
3.  Upon successful authorization, it will print a **Base64 encoded credential string** to your terminal.

You can run this script multiple times for different Google accounts to generate multiple credentials.

#### `CODE_BUDDY` Provider

To obtain credentials for the `CODE_BUDDY` provider (macOS only):

1.  Install the CodeBuddy CLI tool by following the instructions at https://www.codebuddy.ai/cli
2.  Run the CodeBuddy tool and complete the login process
3.  Extract your authentication key by running the following command in your terminal:
    ```bash
    cat "$HOME/Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info" | base64
    ```
4.  The output will be your **Base64 encoded credential string** for the `CODE_BUDDY` provider

**Note:** The credential extraction method above is currently only available for macOS systems. Methods for other operating systems are to be determined.

#### `GOOGLE_AI_STUDIO` Provider

To obtain credentials for the `GOOGLE_AI_STUDIO` provider:

1.  Visit https://aistudio.google.com/api-keys to access the Google AI Studio API Keys page
2.  Sign in with your Google account if not already logged in
3.  Click "Create API Key" to generate a new API key
4.  Copy the generated API key (it will be a plain text string starting with "AIza...")
5.  Use this **plain text API key** directly as your credential string for the `GOOGLE_AI_STUDIO` provider

**Note:** Unlike other providers that require Base64 encoded credentials, the `GOOGLE_AI_STUDIO` provider uses the plain text API key directly.

#### `OPEN_AI` Provider

The `OPEN_AI` provider allows you to connect to any service that is compatible with the OpenAI API, including the official OpenAI service or other third-party services.

1.  **API Key**: Obtain the API key from your service provider (e.g., from the [OpenAI dashboard](https://platform.openai.com/api-keys)). This is typically a string prefixed with `sk-`.
2.  **Base URL** (Optional): If you are using a third-party service, enter its endpoint URL here (e.g., `https://api.example.com/v1`). If left blank, it will default to the official OpenAI endpoint (`https://api.openai.com/v1`).
3.  **Available Models**: You must specify a list of models supported by this key. In the web UI, enter one model per line (e.g., `gpt-5`).

### Step 3: Add Your Credentials as an API Key

Now, add the credential(s) you just obtained to your user account via the web UI.

1.  Go back to the user management page. If you are not already logged in, paste your **User Token** from Step 1 into the login field and click "Login".
2.  In the "Create New API Key" section:
    -   Select the appropriate provider from the dropdown (`GEMINI_CODE_ASSIST`, `CODE_BUDDY`, `GOOGLE_AI_STUDIO`, or `OPEN_AI`).
    -   Paste the credential string from Step 2 into the "Enter your key from the provider" field.
    -   For the `OPEN_AI` provider, you can also specify an optional **Base URL** and a list of **Available Models**.
    -   Optionally, add a note to remember which account this key corresponds to.
    -   Click "Create Key".

Your new key will appear in the list. Repeat this step for each credential you generated. The proxy will automatically use all available keys from the selected provider associated with your user account.

### Step 4: (Optional) Create Access Tokens for Applications

If you want to use the service in applications or share API access without granting full account management permissions, you can create Access Tokens:

1. In the user management interface, scroll down to the "Access Tokens (API-only Keys)" section.
2. Enter an optional name for the token (e.g., "My App Token").
3. Click "Create Access Token".
4. Copy the generated token (prefixed with `sk-api-`) immediately, as you won't be able to see it again.
5. Use this Access Token in your applications instead of your User Token for safer API access.

Access Tokens can be revoked at any time from the management interface without affecting your User Token or other Access Tokens.

### Step 5: (Optional) Create Custom Model Aliases

If you're using AI tools that don't allow custom model names (they use fixed, built-in model names), you can create custom model aliases to map those fixed names to your desired models:

1. In the user management interface, scroll down to the "Model Aliases" section.
2. Enter an alias name (e.g., "my-model" - this is the name your AI tool will use).
3. Enter the target model(s) in the same format as API requests:
   - Single model: `gemini-2.5-flash` or `GEMINI_CODE_ASSIST/gemini-2.5-flash`
   - Multiple fallback models: `gemini-2.5-pro,gemini-2.5-flash`
   - With provider prefix: `GEMINI_CODE_ASSIST/gemini-2.5-flash,CODE_BUDDY/gemini-2.5-flash`
4. Click "Create Alias".

**How it works:**
- When your AI tool makes a request with the alias name (e.g., "my-model"), FrugalAI automatically replaces it with the target model(s) you configured.
- The rest of the request processing (key selection, rate limiting, etc.) works exactly the same as normal requests.
- Aliases support all features including provider prefixes, model fallbacks, and comma-separated model lists.

**Example use case:**
- Your AI tool is hard-coded to use "gpt-4" as the model name.
- Create an alias: `gpt-4` → `GEMINI_CODE_ASSIST/gemini-2.5-pro,gemini-2.5-flash`
- Now when the tool requests "gpt-4", it actually uses your Gemini models with automatic fallback.

**Note:** Alias names must contain only alphanumeric characters, hyphens, and underscores. Each alias can only map to one set of models, and you can update or delete aliases at any time.

## How to Use the Service

Once you have registered and added at least one API key, you can use the service by providing either your **User Token** (prefixed with `sk-`) or an **Access Token** (prefixed with `sk-api-`) as a Bearer token.

### Provider-Specific Model Selection

The service supports **provider-specific model selection** to give you precise control over which provider to use when multiple providers support the same model. You can specify models in two ways:

1. **With Provider Prefix** (Recommended): `provider_name/model_name`
   - Example: `GEMINI_CODE_ASSIST/gemini-2.5-flash` or `CODE_BUDDY/gemini-2.5-pro`
   - This ensures your request uses the specified provider

2. **Without Provider Prefix**: `model_name`
   - Example: `gemini-2.5-flash`
   - The system will randomly select from available providers that support this model

### Multi-Model Fallback Support

FrugalAI supports specifying multiple fallback models in a single request to improve reliability and reduce rate-limiting errors. When multiple models are specified, the system attempts them sequentially until one succeeds.

**Format:** `model1,model2,model3` (comma-separated, no spaces)

**Examples:**
- `gemini-2.5-pro,gemini-2.5-flash`
- `GEMINI_CODE_ASSIST/gemini-2.5-pro,CODE_BUDDY/gemini-2.5-pro`

**How it works:**
1. FrugalAI first attempts to use `model1` with all available providers that support it
2. If all providers fail or are rate-limited for `model1`, it automatically tries `model2`
3. This continues sequentially until a model succeeds or all models are exhausted

**Benefits:**
- **Seamless fallback** when primary models are rate-limited (429 errors)
- **Reduced interruptions** - similar models often have comparable capabilities, allowing transparent switching
- **Better resource utilization** across your available API keys and models

This feature is particularly useful when models have similar capabilities but different rate limits or availability across providers.

### Model Matching Logic

When you specify a model, FrugalAI uses the following matching logic to find compatible API keys:

**Model Format:** `[provider/]model[$alias]`

- **Provider prefix** (optional): Limits matching to a specific provider (e.g., `GEMINI_CODE_ASSIST/`)
- **Model name** (required): The base model identifier (e.g., `gemini-2.5-flash`)
- **Alias suffix** (optional): An alias name defined in provider configuration (e.g., `$my-alias`)

**Matching Rules:**
1. **Exact Model Match**: If you request `model1`, it matches any configured model with name `model1`, regardless of whether the configuration includes an alias
2. **Alias Match**: If the provider configuration defines `model1$alias1`, you can request either:
   - `model1` - matches by model name
   - `alias1` - matches by alias name
3. **Strict Alias Match**: If you explicitly request `model1$alias1`, it will only match configurations that define exactly `model1$alias1` (both model name and alias must match)

**Example:**
- Provider configuration: `gemini-2.5-flash$fast-model`
- These requests all match:
  - `gemini-2.5-flash` ✓
  - `fast-model` ✓
  - `gemini-2.5-flash$fast-model` ✓
- This request does NOT match:
  - `gemini-2.5-flash$other-alias` ✗

### 1. Test with `curl`

You can use `curl` to call the API directly. The proxy exposes compatible endpoints for the OpenAI, Google Gemini, and Anthropic APIs.

**OpenAI-Compatible Endpoint:**

```bash
curl -X POST "<your_endpoint_url>/v1/chat/completions" \
     -H "Authorization: Bearer <YOUR_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "model": "GEMINI_CODE_ASSIST/gemini-2.5-flash",
           "messages": [{
             "role": "user",
             "content": "Hello, tell me about yourself."
           }]
         }'
```

**Google Gemini-Compatible Endpoint:**

```bash
curl -X POST "<your_endpoint_url>/v1beta/models/GEMINI_CODE_ASSIST/gemini-2.5-flash:generateContent" \
     -H "x-goog-api-key: <YOUR_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "contents": [{
             "parts":[{"text": "Hello, tell me about yourself."}]
           }]
         }'
```

**Anthropic-Compatible Endpoint:**

```bash
curl -X POST "<your_endpoint_url>/v1/messages" \
     -H "x-api-key: <YOUR_TOKEN>" \
     -H "anthropic-version: 2023-06-01" \
     -H "Content-Type: application/json" \
     -d '{
           "model": "gemini-2.5-flash",
           "max_tokens": 1024,
           "messages": [{
             "role": "user",
             "content": "Hello, tell me about yourself."
           }]
         }'
```

Replace `<your_endpoint_url>` and `<YOUR_TOKEN>` with your actual information. `<YOUR_TOKEN>` can be either your User Token (sk-...) or an Access Token (sk-api-...).

### 2. Use in Other Tools

The API provided by this proxy is compatible with the OpenAI, Google Gemini, and Anthropic APIs. This allows you to integrate it with any third-party application or tool (e.g., IDE plugins, specialized AI clients) that supports these API formats and allows you to configure a custom API endpoint.

To set this up, find the API settings in your tool of choice and configure the following:
-   **API Endpoint / Base URL:** Your `<your_endpoint_url>`
-   **API Key:** Your **User Token** (prefixed with `sk-`) or **Access Token** (prefixed with `sk-api-`)

Once configured, the tool will communicate with this proxy, allowing you to leverage all of its features, such as key pooling and multi-model fallback.

**Security Recommendation:** For applications and shared environments, use Access Tokens instead of User Tokens to limit access to API functionality only.

---

## Integration with Other Tools

FrugalAI can be integrated with various AI coding assistants that support custom API endpoints. Here are some examples:

### Using with Claude Code

[Claude Code](https://github.com/anthropics/claude-code) is a command-line tool for interacting with Claude. You can configure it to use FrugalAI by setting several environment variables:

```bash
# Set the base URL to point to your FrugalAI service (without "v1" path)
# For local development: http://localhost:8787/
# For deployed service: https://your-worker-name.your-subdomain.workers.dev/
export ANTHROPIC_BASE_URL="<your_endpoint_url>"

# Configure model selection (choose your preferred models)
export ANTHROPIC_MODEL="gemini-2.5-pro"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gemini-2.5-flash"
export ANTHROPIC_DEFAULT_SONNET_MODEL="gemini-2.5-pro"
export ANTHROPIC_DEFAULT_OPUS_MODEL="gemini-2.5-pro"

# Set your FrugalAI API key (User Token or Access Token)
export ANTHROPIC_AUTH_TOKEN="sk-xxx"

# Run claude
claude
```

Replace `<your_endpoint_url>` with your FrugalAI deployment URL (without trailing "v1"), and `sk-xxx` with your actual FrugalAI token.

### Using with Codex

[Codex](https://github.com/openai/codex) is an AI coding assistant from OpenAI. To use it with FrugalAI:

#### Step 1: Configure Codex

Add a new `model_provider` configuration to your `~/.codex/config.toml` file:

```toml
model = "gpt-5-codex"
model_provider = "frugalai"

[model_providers.frugalai]
name = "FrugalAI"
# For local development: http://localhost:8787/v1
# For deployed service: https://your-worker-name.your-subdomain.workers.dev/v1
base_url = "<your_endpoint_url>/v1"
env_key = "FRUGALAI_API_KEY"
wire_api = "chat"
query_params = { "remove-empty-finish-reason" = "true" }
```

Replace `<your_endpoint_url>` with your FrugalAI deployment URL (note the "/v1" suffix is required for Codex).

This configuration tells Codex to use FrugalAI as the model provider and sets up the necessary API parameters.

#### Step 2: Set Environment Variable and Run

Before starting Codex, set your FrugalAI API key as an environment variable:

```bash
# Set your FrugalAI API key (User Token or Access Token)
export FRUGALAI_API_KEY="sk-xxx"

# Run codex
codex
```

Replace `sk-xxx` with your actual FrugalAI token.

---

## Database Development with Prisma and Cloudflare D1

This project uses [Prisma](https://www.prisma.io/) as its ORM to interact with a [Cloudflare D1](https://developers.cloudflare.com/d1/) database. This section outlines the correct development workflow for modifying the database schema and managing migrations, following Cloudflare's recommended practices.

### 1. Prerequisites

Ensure you have [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/), the Cloudflare CLI, installed and authenticated.

### 2. Development Workflow

Here is the step-by-step process for making schema changes:

#### Step 1: Modify the Prisma Schema

Edit the `prisma/schema.prisma` file to reflect your desired database changes (e.g., adding a model, updating a field).

```prisma
// prisma/schema.prisma
model ApiKey {
  // ... existing fields
  notes        String? // Add a new optional 'notes' field
}
```

#### Step 2: Create a New Migration File

Use Wrangler to create a new, empty migration file.

```bash
npx wrangler d1 migrations create <YOUR_DATABASE_NAME> <your_migration_name>
```

-   Replace `<YOUR_DATABASE_NAME>` with the `database_name` (not the `binding` name) from your `wrangler.jsonc` file.
-   Replace `<your_migration_name>` with a descriptive name (e.g., `add_apikey_notes`).

This command creates a new folder in the `migrations` directory containing an empty `.sql` file.

#### Step 3: Generate the SQL for the Migration

Use Prisma to compare your current local database state with your updated `schema.prisma` file and generate the necessary SQL. The output will be written directly into the empty migration file you just created.

```bash
npx prisma migrate diff \
  --from-local-d1 \
  --to-schema-datamodel ./prisma/schema.prisma \
  --script \
  --output ./migrations/<000X_your_migration_name>.sql
```

-   Make sure to replace the `--output` path with the correct path to the SQL file generated in Step 2.

#### Step 4: Apply the Migration Locally

Apply the newly generated migration to your local D1 database to keep it in sync. This is crucial for the next migration's `diff` to work correctly.

```bash
npx wrangler d1 migrations apply <YOUR_DATABASE_NAME> --local
```

-   Replace `<YOUR_DATABASE_NAME>` with the `database_name` from `wrangler.jsonc`.

After this step, you should also regenerate your Prisma Client to make sure it's aware of the schema changes:

```bash
npx prisma generate
```

Now you can run `npm run dev` to test your changes locally.

#### Step 5: Apply the Migration to Production

Once you have tested your changes and are ready to deploy, apply the migration to your production D1 database.

```bash
npx wrangler d1 migrations apply <YOUR_DATABASE_NAME> --remote
```

-   Replace `<YOUR_DATABASE_NAME>` with the `database_name` from `wrangler.jsonc`.

After the migration is successfully applied, you can deploy your updated worker code:

```bash
npm run deploy
```

By following this process, you can safely and effectively manage your database schema in both local and production environments.
