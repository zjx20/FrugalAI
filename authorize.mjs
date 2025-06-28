import { OAuth2Client } from 'google-auth-library';
import http from 'http';
import url from 'url';
import open from 'open';
import net from 'net';
import { setupUser } from '@google/gemini-cli-core/dist/src/code_assist/setup.js';

// These are the public credentials for an "Installed App".
// It's safe for them to be in this script.
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const OAUTH_SCOPE = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
];

async function getAvailablePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, () => {
            const { port } = server.address();
            server.close(() => {
                resolve(port);
            });
        });
    });
}

async function main() {
    const port = await getAvailablePort();
    const redirectUri = `http://localhost:${port}/oauth2callback`;

    const client = new OAuth2Client({
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET,
        redirectUri: redirectUri,
    });

    const authUrl = client.generateAuthUrl({
        access_type: 'offline',
        scope: OAUTH_SCOPE,
        prompt: 'consent' // Force getting a refresh token every time
    });

    console.log('--------------------------------------------------------------------------');
    console.log('Please open the following URL in your browser to authorize this application:');
    console.log(`\n${authUrl}\n`);
    console.log('Waiting for authorization...');
    console.log('--------------------------------------------------------------------------');

    open(authUrl);

    const server = http.createServer(async (req, res) => {
        // Only process the /oauth2callback path
        if (req.url.startsWith('/oauth2callback')) {
            try {
                const qs = new url.URL(req.url, `http://localhost:${port}`).searchParams;
                const code = qs.get('code');

                if (!code) {
                    res.end('Authorization failed: No code received.');
                    server.close(); // Close on error
                    return;
                }

                const { tokens } = await client.getToken(code);
                client.setCredentials(tokens);

                if (!tokens.refresh_token) {
                     res.end('Authorization failed. A refresh token is required. Please try again.');
                     server.close(); // Close on error
                     return;
                }

                // Use setupUser from @google/gemini-cli-core to get the projectId
                const projectId = await setupUser(client);

                const credentialsData = {
                    tokens: tokens,
                    projectId: projectId,
                };

                const credentialsString = JSON.stringify(credentialsData);
                const encodedCredentials = Buffer.from(credentialsString).toString('base64');

                res.end('Authorization successful! You can close this tab now.');
                server.close(); // Close on success

                console.log('Authorization successful!');
                console.log('--------------------------------------------------------------------------');
                console.log('Copy the following string and paste it into the registration page:');
                console.log(`\n${encodedCredentials}\n`);
                console.log('--------------------------------------------------------------------------');

            } catch (e) {
                res.end(`Authorization failed: ${e.message}`);
                server.close(); // Close on error
                console.error(e);
            }
        } else {
            // Ignore other requests like favicon.ico
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('OK');
        }
    }).listen(port);
}

main().catch(console.error);
