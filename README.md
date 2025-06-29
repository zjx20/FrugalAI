# FrugalAI

The solution for the poor, long live free access!

This project is a Cloudflare Worker that acts as a proxy for the Google Gemini API. It exposes an interface compatible with the official Google Gemini API and internally translates requests to the Google Code Assist API format, enabling free access to Gemini models.

The project includes a complete OAuth2 flow to authorize access to Google services, securely storing the obtained credentials (access tokens, refresh tokens) in a Cloudflare KV namespace. Each user is issued a unique API key to access the service.

## Deployment and Operation

You can run this project either in a local development mode or by deploying it directly to Cloudflare. In either case, you will get an **Endpoint URL**, which is the access address for your service.

### 1. Prerequisites

Before you begin, ensure you have the following:

-   [Node.js](https://nodejs.org/) (v20.x or later recommended)
-   An active [Cloudflare account](https://dash.cloudflare.com/sign-up)
-   A configured Cloudflare KV namespace

### 2. Installation and Configuration

First, clone the repository and install the dependencies:

```bash
git clone <repository-url>
cd frugalai
npm install
```

Next, bind your KV namespace to this worker. Open the `wrangler.jsonc` file and add or modify the `kv_namespaces` configuration:

```jsonc
// wrangler.jsonc
{
  // ... other configurations
  "kv_namespaces": [
    {
      "binding": "KV",
      "id": "your_kv_namespace_id",
      "preview_id": "your_kv_namespace_preview_id"  // Optional
    }
  ]
}
```

Replace `your_kv_namespace_id` and `your_kv_namespace_preview_id` with the actual IDs from your Cloudflare dashboard.

### 3. Running the Project

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

## User Authorization and API Key Management

The core of this project is its user authorization system, which now supports both individual API keys and "Fleet" API keys for enhanced rate limit management.

### Fleet API Key Feature Overview

The "API Key Fleet" feature allows you to group multiple OAuth accounts under a single public API key. When a request is made using a Fleet API Key, the system intelligently rotates through the accounts in the fleet. If an internal account encounters a 429 (Too Many Requests) error, the system automatically switches to another available account within the fleet, providing a more robust and resilient service. This helps in managing rate limits more effectively across multiple underlying Google accounts.

### 1. Authorize and Get an API Key

In your project terminal, run the `authorize.mjs` script. Replace `<your_endpoint_url>` with the **Endpoint URL** you obtained in the previous step.

```bash
node authorize.mjs --endpoint=<your_endpoint_url> [options]
```

> **Note:** The `--endpoint` parameter is **required**.

This script will automatically perform the following actions:
1.  Open a Google authorization page in your browser.
2.  Prompt you to log in and grant the application permission to access your Google account information and Cloud Platform data.
3.  After successful authorization, the script will capture the credentials and send a registration request to your endpoint.
4.  Finally, your **API Key** (either individual or fleet) will be printed directly to the terminal.

Please store this API key securely, as it is required for all subsequent requests.

#### Options for `authorize.mjs`:

*   **Registering an Individual API Key (Default):**
    ```bash
    node authorize.mjs --endpoint=<your_endpoint_url>
    ```
    This will register a single OAuth account and issue a standard API key.

*   **Registering a New Fleet API Key (and setting the Captain):**
    ```bash
    node authorize.mjs --endpoint=<your_endpoint_url> --register-fleet
    ```
    Use this option to create a new Fleet. The Google account you authorize during this process will become the "captain" (first member) of this new fleet. The script will output a `fleet-` prefixed API key. **Keep this key safe**, as it is your primary key for managing and using this fleet.

*   **Adding a Member to an Existing Fleet:**
    ```bash
    node authorize.mjs --endpoint=<your_endpoint_url> --fleet-api-key=<YOUR_FLEET_API_KEY>
    ```
    Use this option to add another Google account as a member to an existing fleet. Replace `<YOUR_FLEET_API_KEY>` with the fleet API key obtained during fleet registration. The Google account you authorize during this process will be added to the specified fleet.

### 2. Revoke Authorization

You can revoke authorization for individual API keys or entire fleets.

*   **Revoking an Individual API Key:**
    ```bash
    curl -X POST <your_endpoint_url>/revoke \
         -H "Authorization: Bearer YOUR_INDIVIDUAL_API_KEY"
    ```
    This action will revoke the application's access token with Google and delete your individual user data from the KV store.

*   **Revoking a Fleet API Key:**
    ```bash
    curl -X POST <your_endpoint_url>/revoke \
         -H "Authorization: Bearer YOUR_FLEET_API_KEY"
    ```
    This will revoke authorization for all member accounts within the specified fleet and delete the entire fleet's data from the KV store.

*   **Removing a Specific Member from a Fleet:**
    To remove a single member from a fleet without revoking the entire fleet, send a POST request to the `/fleet/remove` endpoint. You will need the fleet's API key and the `userId` of the member to remove.
    ```bash
    curl -X POST <your_endpoint_url>/fleet/remove \
         -H "Content-Type: application/json" \
         -H "Authorization: Bearer YOUR_FLEET_API_KEY" \
         -d '{
               "userId": "USER_ID_OF_MEMBER_TO_REMOVE"
             }'
    ```
    You can find the `userId` of a member by inspecting the `fleetData` in your KV store (e.g., by temporarily logging it in your worker code during development).

## How to Use the Service

Once you have your API key (individual or fleet), you can use this proxy service in several ways.

### 1. Test with `curl`

You can use `curl` to call the API directly and test its connectivity.

```bash
curl -X POST "<your_endpoint_url>/v1beta/models/gemini-2.5-flash:generateContent?key=YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
           "contents": [{
             "parts":[{"text": "Hello, tell me about yourself."}]
           }]
         }'
```

Replace `<your_endpoint_url>` and `YOUR_API_KEY` with your actual information. Note that `YOUR_API_KEY` can now be either an individual API key or a Fleet API key.

### 2. Test via the Web Interface

This project includes a simple web-based chat interface for quick testing.

1.  Open your **Endpoint URL** (e.g., `http://localhost:8787`) in your browser.
2.  In the "Enter Your API Key" input field, paste the API key you obtained.
3.  Click the "Save Key" button. The key will be saved in your browser's local storage for future sessions.
4.  You can now start chatting with the Gemini model directly in the chatbox.

### 3. Use in Other Tools

The API provided by this proxy is fully compatible with the official Google Gemini API. This allows you to integrate it with any third-party application or tool (e.g., IDE plugins, specialized AI clients) that allows you to configure a custom API endpoint or base URL.

The primary benefit of this approach is significant cost savings. By routing API calls through this proxy, you can leverage the free tier of the underlying Google services. This allows you to bypass potentially expensive pay-per-use fees for the official Gemini API or avoid paid subscriptions for third-party software that integrates with it.

To set this up, find the API settings in your tool of choice and configure the following:
-   **API Endpoint / Base URL:** Your `<your_endpoint_url>`.
-   **API Key:** The `YOUR_API_KEY` you obtained from the `authorize.mjs` script. This can be either an individual API key or a Fleet API key.

Once configured, the tool will communicate with this proxy, allowing you to use its features powered by Gemini at no cost.
