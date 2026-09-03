import fetch from 'node-fetch';
import { URLSearchParams } from 'url';

import { SIGN_IN_ACTION } from '../actions/common';
import { getAuthServerUrl, getClientId } from '../config/spotify-config';
import { getState, getStore } from '../store/store';

/**
 * Refresh the Spotify access token.
 * - default: through the shared auth server (resound.krisnarhesa.dev)
 * - if the user set their own `spotify.clientId`: straight to Spotify, because the
 *   shared server has no record of a token issued to a different app.
 * Shared by `spotify-fetch` (on 401) and `actions.refreshAccessToken`.
 */
export async function refreshSpotifyToken(): Promise<string | null> {
    const refreshToken = getState().loginState?.refreshToken;
    if (!refreshToken) { return null; }

    const clientId = getClientId();

    try {
        const res = clientId
            ? await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: clientId
                }).toString()
            })
            : await fetch(`${getAuthServerUrl() || 'https://resound.krisnarhesa.dev'}/refresh_token?refresh_token=${encodeURIComponent(refreshToken)}`);

        if (res.ok) {
            const data: any = await res.json();
            const accessToken = data.access_token || data.accessToken;
            if (accessToken) {
                getStore().dispatch({
                    type: SIGN_IN_ACTION,
                    accessToken,
                    refreshToken: data.refresh_token || data.refreshToken || refreshToken
                } as any);
                return accessToken;
            }
        }
    } catch { /* silent */ }
    return null;
}
