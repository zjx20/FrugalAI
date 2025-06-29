# Project Context for Gemini Agent

This document provides essential context about the "Gemini Free API Proxy" project for the Gemini CLI Agent. It outlines the project's architecture, functionality, and key workflows to guide the agent in understanding and modifying the codebase.

## 1. Project Overview

This project is a Cloudflare Worker that acts as a proxy to the Google Gemini API. It exposes a public API endpoint that is compatible with the official Google GenAI API specification. Internally, it translates incoming requests to the format required by the Google Code Assist API, effectively enabling free access to Gemini models.

The core of the project involves a user authorization flow that uses OAuth2 to obtain Google API credentials. These credentials are then securely stored in a Cloudflare KV namespace. Each user is issued a unique API key to access the service.

A new "API Key Fleet" feature has been introduced, allowing multiple OAuth accounts to be grouped under a single public API key. This enables intelligent rotation through accounts to manage rate limits more effectively.

## 2. Core Components

-   **`src/index.ts`**: The main Cloudflare Worker script, built with Hono. It handles all API routing, including:
    -   `/register`: An internal endpoint for the authorization script to register user credentials and generate an API key.
    -   `/revoke`: An endpoint for users to revoke their authorization and delete their data.
    -   `/v1beta/models/*`: The main proxy endpoint that forwards user requests to the Google API after validating the API key and refreshing OAuth tokens.
-   **`authorize.mjs`**: A command-line Node.js script that guides the user through the Google OAuth2 flow. It requires an `--endpoint` parameter pointing to the running worker. Upon successful authorization, it communicates directly with the `/register` endpoint to obtain and display the final API key for the user.
-   **`public/index.html`**: A simple, static web page that serves as a chat interface for testing the service. It requires the user to input their API key, which is then stored in the browser's local storage.
-   **`wrangler.jsonc`**: The configuration file for the Cloudflare Worker, including the necessary KV namespace binding.

## 3. Key Workflows

### 3.1. Authorization and API Key Generation

The process for a user to obtain an API key has been expanded to support individual keys and fleet keys:

1.  The user runs the Cloudflare Worker, either locally (`npm run dev`) or by deploying it (`npm run deploy`), to get a service **Endpoint URL**.

2.  The user runs the `authorize.mjs` script from their terminal, providing the endpoint URL and optionally specifying the type of key to generate:

    *   **For an Individual API Key:**
        ```bash
        node authorize.mjs --endpoint=<your_endpoint_url>
        ```
        The script opens a browser for the Google OAuth2 consent flow. After authorization, it sends the credentials to the worker's `/register` endpoint. The worker generates a unique API key, stores user data in KV, and returns the key to the script, which then prints it to the console.

    *   **For a New Fleet API Key (and setting the Captain):**
        ```bash
        node authorize.mjs --endpoint=<your_endpoint_url> --register-fleet
        ```
        The script initiates the OAuth2 flow. The authorized Google account's credentials are then sent to the worker's `/fleet/register` endpoint. The worker creates a new fleet, assigns the authorized account as its first member (captain), generates a `fleet-` prefixed API key, and stores the fleet data in KV. The new fleet API key is then printed to the console.

    *   **To Add a Member to an Existing Fleet:**
        ```bash
        node authorize.mjs --endpoint=<your_endpoint_url> --fleet-api-key=<YOUR_FLEET_API_KEY>
        ```
        The script performs the OAuth2 flow for the new member's Google account. The authorized credentials are then sent to the worker's `/fleet/add` endpoint, along with the provided `YOUR_FLEET_API_KEY`. The worker adds the new member's credentials to the specified fleet's data in KV.

3.  In all cases, the script handles the OAuth2 consent flow, receives authorization tokens, and communicates with the worker to register or update credentials. The final API key (individual or fleet) is printed to the user's console.

### 3.2. API Request Flow

1.  A user makes a request to the proxy endpoint (e.g., `/v1beta/models/gemini-2.5-flash:generateContent`), providing their API key in the `?key=` query parameter.
2.  The worker retrieves the `userId` from KV using the API key.
3.  It then retrieves the user's stored credentials (OAuth tokens) using the `userId`.
4.  The worker refreshes the `access_token` if necessary.
5.  **For Individual API Keys:** The worker uses the individual user's credentials to forward the request to the internal Google Code Assist API.
6.  **For Fleet API Keys:** The worker intelligently selects an available member from the fleet. If a member encounters a 429 (Too Many Requests) error, it is temporarily throttled, and the worker attempts the request with another available member. The selected member's credentials are used to forward the request.
7.  The response is translated back to the standard Gemini API format and returned to the user.

## 4. Agent Guidelines

This section outlines the operational guidelines for the Gemini CLI Agent when interacting with this project.

1.  **Plan Before Action:** Before making any code modifications, always provide a clear plan of the proposed changes to the user. Proceed with implementation only after receiving explicit confirmation from the user.
2.  **Language Consistency:** Respond to the user in the language they used for their query. However, all code comments within the project must be written in English.
