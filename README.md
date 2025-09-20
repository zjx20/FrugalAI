# FrugalAI

The solution for the poor, long live free access!

This project is a Cloudflare Worker that acts as a proxy for the Google Gemini API. It exposes an OpenAI-compatible API interface and internally translates requests to the Google Code Assist API format, enabling free access to Gemini models.

This project uses a Cloudflare D1 database to store user and API key information, and provides a web interface for management.

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

### 4. (Optional) Setting Up the Administrator Interface

This project includes an administrator interface for managing provider configurations. To enable it, you must set two secret variables in your Cloudflare Worker dashboard. This should be done as part of the deployment process.

1.  **Create `ADMIN_PASSWORD_HASH`**: This is the SHA-256 hash of your desired admin password. Generate it with the following command and copy the output:
    ```bash
    echo -n 'your_admin_password' | shasum -a 256
    ```

2.  **Create `JWT_SECRET`**: This is a secret key for signing authentication tokens. Generate a secure random string with:
    ```bash
    openssl rand -base64 32
    ```

In the Cloudflare dashboard, go to your Worker's **Settings > Variables** and add these two secrets under **Environment Variables**.

Alternatively, you can set them directly from your command line using Wrangler. Run the following commands and paste the secret value when prompted:
```bash
npx wrangler secret put ADMIN_PASSWORD_HASH
npx wrangler secret put JWT_SECRET
```

#### Accessing the Admin Interface

Once your worker is deployed and the secrets are configured, you can access the admin panel by navigating to `/admin.html` on your worker's URL (e.g., `https://your-worker-name.your-subdomain.workers.dev/admin.html`).

## User and API Key Management

This project uses a self-service web UI to manage users and their API keys. A single user can manage multiple API keys from different providers, allowing the proxy to rotate through them to handle rate limits.

The setup process involves three main steps:

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

### Step 3: Add Your Credentials as an API Key

Now, add the credential(s) you just obtained to your user account via the web UI.

1.  Go back to the user management page. If you are not already logged in, paste your **User Token** from Step 1 into the login field and click "Login".
2.  In the "Create New API Key" section:
    -   Select the appropriate provider from the dropdown (`GEMINI_CODE_ASSIST` or `CODE_BUDDY`).
    -   Paste the **Base64 encoded credential string** from Step 2 into the "Enter your key from the provider" field.
    -   Optionally, add a note to remember which account this key corresponds to.
    -   Click "Create Key".

Your new key will appear in the list. Repeat this step for each credential you generated. The proxy will automatically use all available keys from the selected provider associated with your user account.

## How to Use the Service

Once you have registered and added at least one `GEMINI_CODE_ASSIST` key, you can use the service by providing your **User Token** (the one prefixed with `sk-`) as a Bearer token.

### 1. Test with `curl`

You can use `curl` to call the API directly. The proxy exposes two compatible endpoints: one for the OpenAI API and one for the Google Gemini API.

**OpenAI-Compatible Endpoint:**

```bash
curl -X POST "<your_endpoint_url>/v1/chat/completions" \
     -H "Authorization: Bearer <YOUR_USER_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "model": "gemini-2.5-flash",
           "messages": [{
             "role": "user",
             "content": "Hello, tell me about yourself."
           }]
         }'
```

**Google Gemini-Compatible Endpoint:**

```bash
curl -X POST "<your_endpoint_url>/v1beta/models/gemini-2.5-flash:generateContent" \
     -H "x-goog-api-key: <YOUR_USER_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{
           "contents": [{
             "parts":[{"text": "Hello, tell me about yourself."}]
           }]
         }'
```

Replace `<your_endpoint_url>` and `<YOUR_USER_TOKEN>` with your actual information.

### 2. Use in Other Tools

The API provided by this proxy is compatible with the OpenAI Chat Completions API. This allows you to integrate it with any third-party application or tool (e.g., IDE plugins, specialized AI clients) that supports the OpenAI API format and allows you to configure a custom API endpoint.

To set this up, find the API settings in your tool of choice and configure the following:
-   **API Endpoint / Base URL:** Your `<your_endpoint_url>`
-   **API Key:** Your **User Token** (the one prefixed with `sk-`)

Once configured, the tool will communicate with this proxy, allowing you to use its features powered by Gemini at no cost.

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
