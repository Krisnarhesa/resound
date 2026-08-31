import * as express from 'express';
import { Server } from 'http';
import fetch from 'node-fetch';
import { URLSearchParams } from 'url';
import { log } from '../../info/info';
import { getAuthServerUrl } from '../../config/spotify-config';

export interface CreateDisposableAuthSeverPromiseResult {
    accessToken: string;
    refreshToken: string;
}

export function createDisposableAuthSever(clientId?: string, codeVerifier?: string) {
    let server: Server;

    const createServerPromise = new Promise<CreateDisposableAuthSeverPromiseResult>((res, rej) => {
        const timeoutTimer = setTimeout(() => {
            rej('Timeout error: Login was not completed within 10 minutes.');
        }, 10 * 60 * 1000);

        try {
            const app = express();

            app.get('/callback', async (request, response) => {
                clearTimeout(timeoutTimer);
                const { access_token: accessToken, refresh_token: refreshToken, code, error } = request.query;

                if (error) {
                    rej(error as string);
                    response.send(`<!DOCTYPE html>
<html>
<body style="background:#121212;color:#ff5555;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;margin:0;text-align:center">
    <div style="background:#181818;padding:40px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.5);max-width:400px">
        <h2 style="margin:0 0 10px">Login Failed</h2>
        <p style="color:#aaa">${error}</p>
    </div>
</body>
</html>`);
                    return;
                }

                // PKCE Flow (Authorization Code Exchange directly with Spotify)
                if (code && clientId && codeVerifier) {
                    try {
                        const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: new URLSearchParams({
                                grant_type: 'authorization_code',
                                code: code as string,
                                redirect_uri: 'http://127.0.0.1:8350/callback',
                                client_id: clientId,
                                code_verifier: codeVerifier
                            }).toString()
                        });

                        const tokenData: any = await tokenRes.json();
                        if (tokenData.access_token) {
                            res({
                                accessToken: tokenData.access_token,
                                refreshToken: tokenData.refresh_token || ''
                            });

                            const authServerUrl = getAuthServerUrl() || 'https://resound.krisnarhesa.dev';
                            response.redirect(`${authServerUrl}/success`);
                            return;
                        } else {
                            throw new Error(tokenData.error_description || tokenData.error || 'Failed to exchange authorization code');
                        }
                    } catch (e: any) {
                        rej(e.message || e);
                        response.send(`<!DOCTYPE html><html><body style="background:#121212;color:#ff5555;font-family:sans-serif;text-align:center;padding:50px"><h2>Token Exchange Error</h2><p>${e.message || e}</p></body></html>`);
                        return;
                    }
                }

                // Auth Server Callback (e.g. resound.krisnarhesa.dev)
                if (accessToken) {
                    res({ accessToken: accessToken as string, refreshToken: (refreshToken as string) || '' });
                    const authServerUrl = getAuthServerUrl() || 'https://resound.krisnarhesa.dev';
                    response.redirect(`${authServerUrl}/success`);
                } else {
                    res({ accessToken: '', refreshToken: '' });
                    response.send(`<!DOCTYPE html><html><body style="background:#121212;color:#ff5555;font-family:sans-serif;text-align:center;padding:50px"><h2>No token received</h2></body></html>`);
                }
            });

            server = app.listen(8350, () => {
                log('ReSound Auth server listening on port 8350');
            });
        } catch (e) {
            rej(e);
        }
    });

    return {
        createServerPromise,
        dispose: () => server && server.close(() => {
            log('ReSound Auth server closed');
        })
    };
}
