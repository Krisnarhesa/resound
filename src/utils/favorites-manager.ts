import fetch from 'node-fetch';
import { cleanToken } from './utils';
import { getState } from '../store/store';

export interface FavoriteTrack {
    id: string;
    uri: string;
    name: string;
    artist: string;
    album: string;
    imageUrl: string;
    duration: string;
    index?: number;
    addedAt?: number;
}

class FavoritesManager {
    private likedTracks: Map<string, FavoriteTrack> = new Map();
    private removedIds: Set<string> = new Set();
    private isInitialized: boolean = false;
    private isLoading: boolean = false;

    public async initialize(token?: string): Promise<void> {
        if (this.isInitialized || this.isLoading) { return; }
        const activeToken = token || cleanToken(getState().loginState?.accessToken);
        if (!activeToken) { return; }

        this.isLoading = true;
        try {
            const res = await fetch('https://api.spotify.com/v1/me/tracks?limit=50', {
                headers: { 'Authorization': `Bearer ${activeToken}`, 'Content-Type': 'application/json' }
            });

            if (res.ok) {
                const data: any = await res.json();
                const items: any[] = data.items || [];

                items.forEach((item: any, idx: number) => {
                    const track = item?.track || item?.item || item;
                    if (!track || !track.name) { return; }
                    const id = track.id || `track-${idx}`;
                    if (this.removedIds.has(id)) { return; }

                    const ms = track.duration_ms || 0;
                    const min = Math.floor(ms / 60000);
                    const sec = Math.floor((ms % 60000) / 1000);
                    const artists = (track.artists || []).map((a: any) => a.name).join(', ') || 'Unknown Artist';
                    const albumImages = track.album?.images || [];
                    const img = albumImages.length > 0 ? albumImages[albumImages.length - 1].url : '';

                    this.likedTracks.set(id, {
                        id,
                        uri: track.uri || (track.id ? `spotify:track:${track.id}` : ''),
                        name: track.name,
                        artist: artists,
                        album: track.album?.name || 'Liked Songs',
                        imageUrl: img,
                        duration: `${min}:${sec.toString().padStart(2, '0')}`,
                        index: idx,
                        addedAt: new Date(item.added_at || Date.now()).getTime()
                    });
                });

                this.isInitialized = true;
            }
        } catch { /* silent */ } finally {
            this.isLoading = false;
        }
    }

    public isLiked(trackId: string, trackName?: string, artistName?: string): boolean {
        if (!trackId && !trackName) { return false; }
        if (trackId && this.removedIds.has(trackId)) { return false; }
        if (trackId && this.likedTracks.has(trackId)) { return true; }

        if (trackName && artistName) {
            const cleanT = trackName.toLowerCase().trim();
            const cleanA = artistName.toLowerCase().trim();
            for (const t of this.likedTracks.values()) {
                if (t.name.toLowerCase().trim() === cleanT && t.artist.toLowerCase().trim().includes(cleanA.split(',')[0].trim())) {
                    return true;
                }
            }
        }
        return false;
    }

    public async addFavorite(track: FavoriteTrack, token?: string): Promise<boolean> {
        if (!track || !track.id) { return false; }
        this.removedIds.delete(track.id);
        this.likedTracks.set(track.id, {
            ...track,
            addedAt: Date.now()
        });

        const activeToken = token || cleanToken(getState().loginState?.accessToken);
        if (activeToken) {
            try {
                await fetch('https://api.spotify.com/v1/me/tracks', {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${activeToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ ids: [track.id] })
                });
            } catch { /* silent */ }
        }
        return true;
    }

    public async removeFavorite(trackId: string, token?: string): Promise<boolean> {
        if (!trackId) { return false; }
        this.removedIds.add(trackId);
        this.likedTracks.delete(trackId);

        const activeToken = token || cleanToken(getState().loginState?.accessToken);
        if (activeToken) {
            try {
                await fetch('https://api.spotify.com/v1/me/tracks', {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${activeToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ ids: [trackId] })
                });
            } catch { /* silent */ }
        }
        return true;
    }

    public async getLikedTracks(token?: string, forceRefresh: boolean = false): Promise<FavoriteTrack[]> {
        if (!this.isInitialized || forceRefresh) {
            await this.initialize(token);
        }
        const list = Array.from(this.likedTracks.values());
        list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        return list.map((t, idx) => ({ ...t, index: idx }));
    }

    public async getLikedCount(token?: string): Promise<number> {
        if (!this.isInitialized) {
            await this.initialize(token);
        }
        return this.likedTracks.size;
    }
}

export const favoritesManager = new FavoritesManager();
