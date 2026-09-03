import fetch, { RequestInit, Response } from 'node-fetch';

import { refreshSpotifyToken } from '../auth/refresh';
import { getState } from '../store/store';
import { cleanToken } from './utils';

/**
 * Single choke point for every call to api.spotify.com.
 *
 * Why this exists: the codebase had ~25 ad-hoc `fetch('https://api.spotify.com/...')`
 * call sites, each re-implementing the auth header and (some of them) a 401 refresh.
 * None handled 429. With a shared client_id across all users, a burst of 429s from one
 * screen used to keep every screen hammering. Now:
 *   - one global cooldown: after a 429, every caller short-circuits until Retry-After passes
 *   - 401/403 -> refresh the token once, retry once
 *   - the auth header is injected here, not copy-pasted per call
 */

let rateLimitedUntil = 0;

/** ms remaining on the global Spotify cooldown, or 0 if clear. */
export function rateLimitRemainingMs(): number {
    return Math.max(0, rateLimitedUntil - Date.now());
}

function humanizeMs(ms: number): string {
    const s = Math.ceil(ms / 1000);
    if (s < 60) { return `${s}s`; }
    if (s < 3600) { return `${Math.round(s / 60)} min`; }
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
}

export class SpotifyRateLimitError extends Error {
    readonly retryAfterMs: number;
    constructor(retryAfterMs: number) {
        super(`Spotify is rate-limiting this app — try again in ${humanizeMs(retryAfterMs)}. Tip: ReSound: Sign In > "Use my own Spotify Client ID" to use your own quota.`);
        this.name = 'SpotifyRateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}

export interface SpotifyFetchInit extends RequestInit {
    /** don't attach the bearer token (very rare) */
    noAuth?: boolean;
    /** on 429, return the response instead of throwing (still records the cooldown) */
    swallowRateLimit?: boolean;
}

function buildInit(init: SpotifyFetchInit, token: string): RequestInit {
    const { noAuth, swallowRateLimit, headers, ...rest } = init;
    return {
        ...rest,
        headers: {
            'Content-Type': 'application/json',
            ...(headers as Record<string, string> | undefined),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    };
}

export async function spotifyFetch(url: string, init: SpotifyFetchInit = {}): Promise<Response> {
    const cooldown = rateLimitRemainingMs();
    if (cooldown > 0 && !init.swallowRateLimit) {
        throw new SpotifyRateLimitError(cooldown);
    }

    const token = init.noAuth ? '' : cleanToken(getState().loginState?.accessToken);
    let res = await fetch(url, buildInit(init, token));

    if ((res.status === 401 || res.status === 403) && !init.noAuth) {
        const fresh = await refreshSpotifyToken();
        if (fresh) {
            res = await fetch(url, buildInit(init, cleanToken(fresh)));
        }
    }

    if (res.status === 429) {
        const header = parseInt(res.headers.get('retry-after') || '', 10);
        const ms = (Number.isFinite(header) && header > 0 ? header : 5) * 1000;
        rateLimitedUntil = Date.now() + ms;
        if (!init.swallowRateLimit) {
            throw new SpotifyRateLimitError(ms);
        }
    }

    return res;
}
