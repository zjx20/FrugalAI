# Gemini Free API Proxy

This project is a Cloudflare Worker that acts as a proxy to the Google Gemini API. It exposes a Google GenAI-style API and internally translates the requests to the Google Code Assist API format.

It includes a complete OAuth2 flow to authorize access to Google services, storing the obtained credentials (access tokens, refresh tokens) securely in a Cloudflare KV namespace. Each user is issued a unique API key to access the service.

## Features

-   **Gemini API Proxy:** Acts as a middleman to the Google Gemini API.
-   **Multi-User OAuth2 Integration:** Implements the server-side OAuth2 authorization code flow to obtain Google API credentials for multiple users.
-   **API Key Authentication:** Issues a unique, random API key to each user for secure access to the worker's endpoints.
-   **Secure Credential Storage:** Uses Cloudflare KV to store and manage OAuth tokens and API key mappings.
-   **Built with Hono:** Utilizes the Hono web framework for routing within the Cloudflare Worker.
-   **Ready to Deploy:** Configured for easy deployment to the Cloudflare global network.

## Prerequisites

Before you begin, ensure you have the following:

-   [Node.js](https://nodejs.org/) (version 20.x or later recommended)
-   An active [Cloudflare account](https://dash.cloudflare.com/sign-up)
-   A configured Cloudflare KV namespace

## Installation

1.  Clone the repository:
    ```bash
    git clone <repository-url>
    cd gemini-free-api
    ```

2.  Install the dependencies:
    ```bash
    npm install
    ```

## Configuration

### 1. Cloudflare KV Namespace

You need to bind a KV namespace to this worker. Update your `wrangler.jsonc` file to include the KV namespace binding.

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

Replace `your_kv_namespace_id` and `your_kv_namespace_preview_id` with the actual IDs from your Cloudflare dashboard. The `binding` must be `"KV"` as it's used in the code.

## Usage

### Running Locally

To start the local development server, run:

```bash
npm run dev
```

This will start a server, typically on `http://localhost:8787`.

### Authorization and Registration Flow

Since Google's OAuth for "Installed Apps" does not allow arbitrary redirect URIs, the authorization process is split into two steps:

1.  **Local Authorization Script:**
    *   **Before running, ensure you have installed all project dependencies by running `npm install` in the project root.**
    *   Run the `authorize.mjs` script on your local machine using Node.js:
        ```bash
        node authorize.mjs
        ```
    *   This script will open your browser to Google's OAuth consent screen.
    *   After you grant permission, Google will redirect back to a temporary local server run by the script.
    *   The script will then print a Base64-encoded string containing your Google API credentials (including the refresh token and your Google Cloud Project ID) to your terminal. **Copy this entire string.**

2.  **Register Credentials with the Worker:**
    *   Navigate to the worker's homepage (e.g., `http://localhost:8787`).
    *   In the "Register Credentials" section, paste the Base64-encoded string you copied from the terminal into the provided text area.
    *   Click the "Register & Get API Key" button.
    *   The worker will process your credentials, generate a unique API key for you, and display it in the "Your API Key" field. This API key will also be automatically saved to your browser's local storage.

## Web Interface

This worker includes a simple web interface for interacting with the API.

1.  **Homepage:** Navigate to the root URL of your worker (e.g., `http://localhost:8787`) to access the chat interface.
2.  **API Key:** Your API key will be automatically populated after successful registration. It will be stored in your browser's local storage for future use.
3.  **Chat:** Once your API key is set, you can start chatting with the Gemini model.

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

If you wish to invalidate your API key and remove your credentials from the service, you can make a `POST` request to the `/revoke` endpoint.

**Example using `curl`:**

```bash
curl -X POST http://localhost:8787/revoke \
     -H "Authorization: Bearer YOUR_API_KEY"
```

This will revoke your token with Google, delete your credentials from the KV store, and invalidate your API key.

### Deployment



To deploy the worker to your Cloudflare account, run:

```bash
npm run deploy
```

This will publish the worker and make it available on your Cloudflare domain.
