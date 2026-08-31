export function artistsToArtist(artists: { name: string }[]): string {
    return artists.map((a => a.name)).join(', ');
}

export function cleanToken(token?: string | null): string {
    if (!token) { return ''; }
    return token
        .replace(/^Bearer\s+/i, '')
        .replace(/^["']|["']$/g, '')
        .replace(/[\r\n\t]/g, '')
        .trim();
}

export async function parseSpotifyError(res: any): Promise<string> {
    try {
        const text = await res.text();
        const json = JSON.parse(text);
        if (json?.error?.message) {
            return json.error.message;
        }
        if (res.status === 401) {
            return 'Spotify session expired (401). Please enter a fresh Access Token.';
        }
        if (res.status === 403) {
            return 'Spotify session expired or access forbidden (403). Please refresh your Access Token.';
        }
        return text || `HTTP ${res.status}: ${res.statusText}`;
    } catch {
        if (res.status === 401) {
            return 'Spotify session expired (401). Please enter a fresh Access Token.';
        }
        if (res.status === 403) {
            return 'Spotify session expired or access forbidden (403). Please refresh your Access Token.';
        }
        return `HTTP ${res.status}: ${res.statusText}`;
    }
}