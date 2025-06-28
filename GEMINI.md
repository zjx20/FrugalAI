# Gemini Free API

This project is a Cloudflare Worker that acts as a proxy to the Google Gemini API. It provides a Google GenAI-style API endpoint and translates requests to the Google Code Assist API.

The project now supports a two-step OAuth2 authorization and registration process, designed to work with Google's "Installed App" OAuth client type. Credentials (access tokens, refresh tokens) are stored in a Cloudflare KV namespace, and each user is issued a unique API key.

## Core Functionality

-   **API Proxy:** Proxies requests to the Google Gemini API.
-   **OAuth2 Authorization (Local Script):** Users run a local Node.js script (`authorize.mjs`) to obtain Base64-encoded Google API credentials.
-   **Credential Registration (Worker Endpoint):** Users paste the Base64-encoded credentials into the worker's web interface, which then registers them and issues a unique API key.
-   **API Key Authentication:** All API requests to the worker require a valid API key.
-   **Credential Management:** Stores and manages OAuth tokens and API key mappings in Cloudflare KV.
-   **Revocation:** Provides an endpoint (`/revoke`) to invalidate API keys and revoke Google tokens.

## Agent Guidelines

This section outlines the operational guidelines for the Gemini CLI Agent when interacting with this project.

1.  **Plan Before Action:** Before making any code modifications, always provide a clear plan of the proposed changes to the user. Proceed with implementation only after receiving explicit confirmation from the user.
2.  **Language Consistency:** Respond to the user in the language they used for their query. However, all code comments within the project must be written in English.

## Development and Usage

-   **API Proxy:** Proxies requests to the Google Gemini API.
-   **OAuth2 Authorization (Local Script):** Users run a local Node.js script (`authorize.mjs`) to obtain Base64-encoded Google API credentials.
-   **Credential Registration (Worker Endpoint):** Users paste the Base64-encoded credentials into the worker's web interface, which then registers them and issues a unique API key.
-   **API Key Authentication:** All API requests to the worker require a valid API key.
-   **Credential Management:** Stores and manages OAuth tokens and API key mappings in Cloudflare KV.
-   **Revocation:** Provides an endpoint (`/revoke`) to invalidate API keys and revoke Google tokens.

## Development and Usage

### Prerequisites

-   Node.js and npm
-   A Cloudflare account with a KV namespace

### Setup

1.  **Install dependencies:**
    ```bash
    npm install
    ```

2.  **Configure Cloudflare KV Namespace:**
    Update your `wrangler.jsonc` file to include the KV namespace binding. The `binding` must be `"KV"`.

    ```jsonc
    // wrangler.jsonc
    {
      // ... other configurations
      "kv_namespaces": [
        {
          "binding": "KV",
          "id": "your_kv_namespace_id",
          "preview_id": "your_kv_namespace_preview_id"
        }
      ]
    }
    ```

### Running Locally

```bash
npm run dev
```

### Authorization and Registration Flow

1.  **Local Authorization:**
    *   **Before running, ensure you have installed all project dependencies by running `npm install` in the project root.**
    Run the `authorize.mjs` script:
    ```bash
    node authorize.mjs
    ```
    Follow the prompts to authorize with Google and copy the Base64-encoded credentials string (including your Google Cloud Project ID) from your terminal.

2.  **Register Credentials:**
    Navigate to the worker's homepage (e.g., `http://localhost:8787`). Paste the Base64-encoded credentials into the registration section and click "Register & Get API Key". Your new API key will be displayed and saved locally.

### Making API Requests

To use the proxy, make a `POST` request to the `/v1beta/models/<model>:<method>` endpoint with your API key as a query parameter. The `<model>` should be replaced with the actual model you want to use (e.g., `gemini-2.5-flash`), and the `<method>` can be `generateContent` or `streamGenerateContent`. This proxy is fully compatible with the official Google Gemini API, as documented at https://ai.google.dev/gemini-api/docs.

**Example using `curl`:**

```bash
curl -X POST "http://localhost:8787/v1beta/models/gemini-2.5-flash:generateContent?key=YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
           "contents": [{
             "role": "user",
             "parts":[{"text": "Tell me a joke."}]
           }]
         }'
```

Replace `YOUR_API_KEY` with the key you received after the authorization process.

### Revoking Authorization

Make a `POST` request to `/revoke` with your API key in the `Authorization: Bearer` header.

### Deployment

```bash
npm run deploy
```
