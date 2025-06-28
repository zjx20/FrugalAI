import { OAuth2Client } from 'google-auth-library';
import http from 'http';
import url from 'url';
import open from 'open';
import net from 'net';
import fs from 'fs/promises';
import { setupUser } from '@google/gemini-cli-core/dist/src/code_assist/setup.js';

async function getProjectId(client) {
    return await setupUser(client);
}

// These are the public credentials for an "Installed App".
// It's safe for them to be in this script.
const OAUTH_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const OAUTH_SCOPE = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
];

async function register(endpoint, encodedCredentials) {
    const registerUrl = new url.URL('/register', endpoint);
    const postData = JSON.stringify({ credentials: encodedCredentials });

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
        },
    };

    return new Promise((resolve, reject) => {
        const req = http.request(registerUrl, options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`Request failed with status code ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        req.write(postData);
        req.end();
    });
}

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
    const args = process.argv.slice(2);
    const endpointArg = args.find(arg => arg.startsWith('--endpoint='));
    const credentialsFileArg = args.find(arg => arg.startsWith('--credentials-file='));

    const endpoint = endpointArg ? endpointArg.split('=')[1] : null;
    const credentialsFile = credentialsFileArg ? credentialsFileArg.split('=')[1] : null;

    if (!endpoint) {
        console.error('Error: The --endpoint parameter is required.');
        console.error('Usage: node authorize.mjs --endpoint=<your_server_url>');
        process.exit(1);
    }
    let encodedCredentials;

    if (credentialsFile) {
        console.log(`Using credentials from ${credentialsFile}`);
        const credentialsString = await fs.readFile(credentialsFile, 'utf-8');
        const credentials = JSON.parse(credentialsString);

        const client = new OAuth2Client({
            clientId: OAUTH_CLIENT_ID,
            clientSecret: OAUTH_CLIENT_SECRET,
        });
        client.setCredentials(credentials);

        const projectId = await getProjectId(client);
        const credentialsData = {
            tokens: credentials,
            projectId: projectId,
        };
        encodedCredentials = Buffer.from(JSON.stringify(credentialsData)).toString('base64');
    } else {
        encodedCredentials = await getCredentialsFromAuthFlow();
    }

    try {
        console.log(`Registering with endpoint: ${endpoint}`);
        const result = await register(endpoint, encodedCredentials);
        console.log('--------------------------------------------------------------------------');
        console.log('API Key obtained successfully:');
        console.log(`\n${result.apiKey}\n`);
        console.log('You can now use this API key to access the service.');
        console.log('--------------------------------------------------------------------------');
    } catch (error) {
        console.error('Failed to register and get API key:', error.message);
    }
}

async function getCredentialsFromAuthFlow() {
    return new Promise(async (resolve, reject) => {
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
            if (req.url.startsWith('/oauth2callback')) {
                try {
                    const qs = new url.URL(req.url, `http://localhost:${port}`).searchParams;
                    const code = qs.get('code');

                    if (!code) {
                        res.end('Authorization failed: No code received.');
                        server.close();
                        reject(new Error('No code received.'));
                        return;
                    }

                    const { tokens } = await client.getToken(code);
                    client.setCredentials(tokens);

                    if (!tokens.refresh_token) {
                        res.end('Authorization failed. A refresh token is required. Please try again.');
                        server.close();
                        reject(new Error('A refresh token is required.'));
                        return;
                    }

                    const projectId = await getProjectId(client);

                    const credentialsData = {
                        tokens: tokens,
                        projectId: projectId,
                    };

                    const credentialsString = JSON.stringify(credentialsData);
                    const encodedCredentials = Buffer.from(credentialsString).toString('base64');

                    res.end('Authorization successful! You can close this tab now.');
                    server.close();

                    console.log('Authorization successful!');
                    resolve(encodedCredentials);

                } catch (e) {
                    res.end(`Authorization failed: ${e.message}`);
                    server.close();
                    reject(e);
                }
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end('OK');
            }
        }).listen(port);
    });
}

main().catch(console.error);
