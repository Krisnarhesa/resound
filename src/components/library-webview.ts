import {
    CancellationToken,
    WebviewView,
    WebviewViewProvider,
    WebviewViewResolveContext,
    commands
} from 'vscode';
import fetch from 'node-fetch';
import { getState, getStore } from '../store/store';
import { getSpotifyWebApi, refreshAccessToken } from '../actions/actions';
import { cleanToken, parseSpotifyError } from '../utils/utils';
import { favoritesManager } from '../utils/favorites-manager';

interface LibPlaylist {
    id: string;
    name: string;
    owner: string;
    imageUrl: string;
    totalTracks: number;
    uri: string;
}

interface LibTrack {
    id: string;
    uri: string;
    name: string;
    artist: string;
    album: string;
    imageUrl: string;
    duration: string;
    index: number;
}

export class LibraryWebviewProvider implements WebviewViewProvider {
    public static readonly viewType = 'resound-library';

    private _view?: WebviewView;
    private activeTab: 'playlists' | 'albums' = 'playlists';
    private playlists: LibPlaylist[] = [];
    private albums: LibPlaylist[] = [];
    private selectedListId: string = '';
    private selectedListName: string = '';
    private selectedListImage: string = '';
    private tracks: LibTrack[] = [];
    private isLoading: boolean = false;
    private isLoadingTracks: boolean = false;
    private showingTracks: boolean = false;
    private trackError: string = '';

    constructor() {
        getStore().subscribe(() => {
            this.syncFromStore();
        });
    }

    public resolveWebviewView(
        webviewView: WebviewView,
        _context: WebviewViewResolveContext,
        _token: CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'signIn':
                    await commands.executeCommand('resound.signIn');
                    break;
                case 'manualSignIn':
                    await commands.executeCommand('resound.manualSignIn');
                    break;
                case 'switchTab':
                    this.activeTab = message.tab;
                    this.showingTracks = false;
                    this.trackError = '';
                    this.updateWebview();
                    break;
                case 'loadPlaylists':
                    await this.loadPlaylists();
                    break;
                case 'loadAlbums':
                    await this.loadAlbums();
                    break;
                case 'selectPlaylist':
                    await this.selectAndLoadTracks(message.id, message.name, message.image, 'playlist');
                    break;
                case 'selectAlbum':
                    await this.selectAndLoadTracks(message.id, message.name, message.image, 'album');
                    break;
                case 'playTrack':
                    await this.playTrackAtIndex(message.index);
                    break;
                case 'back':
                    this.showingTracks = false;
                    this.trackError = '';
                    this.updateWebview();
                    break;
                case 'refresh':
                    if (this.showingTracks) {
                        await this.selectAndLoadTracks(
                            this.selectedListId,
                            this.selectedListName,
                            this.selectedListImage,
                            this.activeTab === 'playlists' ? 'playlist' : 'album'
                        );
                    } else if (this.activeTab === 'playlists') {
                        await this.loadPlaylists();
                    } else {
                        await this.loadAlbums();
                    }
                    break;
            }
        });

        this.updateWebview();

        const state = getState();
        if (state.loginState?.accessToken && this.playlists.length === 0) {
            this.loadPlaylists();
        }
    }

    public async refreshLibrary(): Promise<void> {
        if (this.showingTracks) {
            await this.selectAndLoadTracks(
                this.selectedListId,
                this.selectedListName,
                this.selectedListImage,
                this.activeTab === 'playlists' ? 'playlist' : 'album'
            );
        } else if (this.activeTab === 'playlists') {
            await this.loadPlaylists();
        } else {
            await this.loadAlbums();
        }
    }

    private syncFromStore() {
        const state = getState();
        const token = state.loginState?.accessToken;
        if (token && this.playlists.length === 0 && !this.isLoading) {
            this.loadPlaylists();
        } else {
            this.updateWebview();
        }
    }

    private async loadPlaylists() {
        this.isLoading = true;
        this.updateWebview();
        try {
            const state = getState();
            const token = cleanToken(state.loginState?.accessToken);
            if (token) {
                const [plRes, likedRes] = await Promise.all([
                    fetch('https://api.spotify.com/v1/me/playlists?limit=50', {
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                    }),
                    fetch('https://api.spotify.com/v1/me/tracks?limit=1', {
                        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                    }).catch(() => null)
                ]);

                let fetchedPlaylists: LibPlaylist[] = [];
                if (plRes.ok) {
                    const data: any = await plRes.json();
                    fetchedPlaylists = (data.items || []).filter((p: any) => p !== null).map((p: any) => ({
                        id: p.id,
                        name: p.name || 'Untitled Playlist',
                        owner: p.owner?.display_name || '',
                        imageUrl: p.images?.[0]?.url || '',
                        totalTracks: p.tracks?.total || 0,
                        uri: p.uri || `spotify:playlist:${p.id}`
                    }));
                }

                let likedCount = await favoritesManager.getLikedCount(token);
                if (likedCount === 0 && likedRes && likedRes.ok) {
                    const likedData: any = await likedRes.json();
                    likedCount = likedData.total || 0;
                }

                const likedItem: LibPlaylist = {
                    id: 'liked-songs',
                    name: 'Liked Songs',
                    owner: 'Auto-playlist',
                    imageUrl: 'liked-gradient',
                    totalTracks: likedCount,
                    uri: 'spotify:user:me:collection'
                };

                this.playlists = [likedItem, ...fetchedPlaylists];
            }
        } catch (e) { /* silent */ }
        this.isLoading = false;
        this.updateWebview();
    }

    private async loadAlbums() {
        this.isLoading = true;
        this.updateWebview();
        try {
            const state = getState();
            const token = cleanToken(state.loginState?.accessToken);
            if (token) {
                const res = await fetch('https://api.spotify.com/v1/me/albums?limit=50', {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                });
                if (res.ok) {
                    const data: any = await res.json();
                    this.albums = (data.items || []).filter((item: any) => item && item.album).map((item: any) => ({
                        id: item.album.id,
                        name: item.album.name || 'Untitled Album',
                        owner: (item.album.artists || []).map((a: any) => a.name).join(', '),
                        imageUrl: item.album.images?.[0]?.url || '',
                        totalTracks: item.album.total_tracks || 0,
                        uri: item.album.uri || `spotify:album:${item.album.id}`
                    }));
                }
            }
        } catch (e) { /* silent */ }
        this.isLoading = false;
        this.updateWebview();
    }

    private async selectAndLoadTracks(id: string, name: string, image: string, type: 'playlist' | 'album') {
        const cleanId = (id || '').replace(/^spotify:(playlist|album):/, '').trim();
        this.selectedListId = cleanId;
        this.selectedListName = cleanId === 'liked-songs' ? 'Liked Songs' : name;
        this.selectedListImage = image;
        this.showingTracks = true;
        this.isLoadingTracks = true;
        this.trackError = '';
        this.tracks = [];
        this.updateWebview();

        try {
            const state = getState();
            const token = cleanToken(state.loginState?.accessToken);
            if (!token) {
                this.trackError = 'Spotify access token required';
                this.isLoadingTracks = false;
                this.updateWebview();
                return;
            }

            let data: any = null;

            if (cleanId === 'liked-songs') {
                const favs = await favoritesManager.getLikedTracks(token);
                if (favs.length > 0) {
                    this.tracks = favs.map((f, idx) => ({
                        id: f.id,
                        uri: f.uri,
                        name: f.name,
                        artist: f.artist,
                        album: f.album,
                        imageUrl: f.imageUrl,
                        duration: f.duration,
                        index: idx
                    }));
                    this.isLoadingTracks = false;
                    this.updateWebview();
                    return;
                }

                const url = 'https://api.spotify.com/v1/me/tracks?limit=50';
                let res = await fetch(url, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                });
                if (res.ok) {
                    data = await res.json();
                }
            } else {
                const isPl = type === 'playlist';
                const url = isPl
                    ? `https://api.spotify.com/v1/playlists/${cleanId}`
                    : `https://api.spotify.com/v1/albums/${cleanId}`;

                let res = await fetch(url, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                });

                if (res.ok) {
                    data = await res.json();
                } else if (res.status === 401 || res.status === 403) {
                    const newToken = await refreshAccessToken();
                    if (newToken) {
                        const retryRes = await fetch(url, {
                            headers: { 'Authorization': `Bearer ${newToken}`, 'Content-Type': 'application/json' }
                        });
                        if (retryRes.ok) {
                            data = await retryRes.json();
                        }
                    }
                }
                
                // Fallback to tracks sub-endpoint if needed
                if (!data) {
                    try {
                        const tracksUrl = isPl
                            ? `https://api.spotify.com/v1/playlists/${cleanId}/tracks?limit=50`
                            : `https://api.spotify.com/v1/albums/${cleanId}/tracks?limit=50`;
                        const resTracks = await fetch(tracksUrl, {
                            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                        });
                        if (resTracks.ok) {
                            data = await resTracks.json();
                        }
                    } catch { /* ignore fallback */ }
                }
            }

            if (!data) {
                throw new Error('Failed to load tracks from Spotify');
            }

            const rawItems: any[] = Array.isArray(data.items?.items)
                ? data.items.items
                : (Array.isArray(data.tracks?.items)
                    ? data.tracks.items
                    : (Array.isArray(data.items)
                        ? data.items
                        : (Array.isArray(data.tracks) ? data.tracks : [])));

            const parsedTracks: LibTrack[] = [];
            rawItems.forEach((rawItem: any, idx: number) => {
                const track = rawItem?.item || rawItem?.track || rawItem;
                if (!track || !track.name) { return; }
                const ms = track.duration_ms || 0;
                const min = Math.floor(ms / 60000);
                const sec = Math.floor((ms % 60000) / 1000);
                const artists = (track.artists || []).map((a: any) => a.name).join(', ') || 'Unknown Artist';
                const albumImages = track.album?.images || [];
                const img = albumImages.length > 0 ? albumImages[albumImages.length - 1].url : (image === 'liked-gradient' ? '' : image || '');
                parsedTracks.push({
                    id: track.id || '',
                    uri: track.uri || (track.id ? `spotify:track:${track.id}` : ''),
                    name: track.name,
                    artist: artists,
                    album: track.album?.name || name,
                    imageUrl: img,
                    duration: `${min}:${sec.toString().padStart(2, '0')}`,
                    index: idx
                });
            });
            this.tracks = parsedTracks;

        } catch (e: any) {
            this.trackError = e?.message || 'Failed to load tracks';
        }

        this.isLoadingTracks = false;
        this.updateWebview();
    }

    private async playTrackAtIndex(index: number) {
        try {
            const state = getState();
            const token = cleanToken(state.loginState?.accessToken);
            const contextUri = this.activeTab === 'playlists'
                ? `spotify:playlist:${this.selectedListId}`
                : `spotify:album:${this.selectedListId}`;

            if (token) {
                if (this.selectedListId === 'liked-songs') {
                    const trackUris = this.tracks.map(t => t.uri).filter(Boolean);
                    if (trackUris.length > 0) {
                        await fetch('https://api.spotify.com/v1/me/player/play', {
                            method: 'PUT',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                uris: trackUris,
                                offset: { position: index }
                            })
                        });
                    }
                } else {
                    const bodyData: any = this.selectedListId
                        ? {
                            context_uri: contextUri,
                            offset: { position: index }
                        }
                        : {
                            uris: this.tracks.map(t => t.uri || (t.id ? `spotify:track:${t.id}` : '')).filter(Boolean).slice(0, 100),
                            offset: { position: index }
                        };

                    const res = await fetch('https://api.spotify.com/v1/me/player/play', {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(bodyData)
                    });

                    if (!res.ok) {
                        const trackUris = this.tracks.map(t => t.uri || (t.id ? `spotify:track:${t.id}` : '')).filter(Boolean);
                        const startIndex = Math.max(0, index);
                        await fetch('https://api.spotify.com/v1/me/player/play', {
                            method: 'PUT',
                            headers: {
                                'Authorization': `Bearer ${token}`,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                uris: trackUris.slice(startIndex, startIndex + 100),
                                offset: { position: 0 }
                            })
                        });
                    }
                }
            } else {
                const api = getSpotifyWebApi();
                if (api) {
                    await api.player.play.put({ offset: index, albumUri: contextUri });
                }
            }
        } catch (e: any) {
            // silent
        }
    }

    private updateWebview() {
        if (!this._view) { return; }
        const e = this.escapeHtml.bind(this);
        const state = getState();
        const token = cleanToken(state.loginState?.accessToken);

        const listItems = (this.activeTab === 'playlists' ? this.playlists : this.albums);

        const listHtml = listItems.map((item, i) => `
            <div class="list-row ${item.id === 'liked-songs' ? 'liked-row' : ''}" data-id="${e(item.id)}" data-name="${e(item.name)}" data-image="${e(item.imageUrl || '')}" style="animation-delay:${i * 0.02}s">
                <div class="list-cover">
                    ${item.imageUrl === 'liked-gradient'
                        ? `<div class="liked-cover-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="#fff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>`
                        : item.imageUrl
                            ? `<img src="${item.imageUrl}" alt="" />`
                            : `<div class="cover-ph"><svg viewBox="0 0 24 24" width="20" height="20" fill="#535353"><path d="${this.activeTab === 'playlists' ? 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z' : 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z'}"/></svg></div>`
                    }
                </div>
                <div class="list-info">
                    <div class="list-name">${e(item.name)}</div>
                    <div class="list-meta">${e(item.owner)} • ${item.totalTracks} tracks</div>
                </div>
                <div class="list-arrow"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg></div>
            </div>
        `).join('');

        const trackListHtml = this.tracks.map((t, i) => `
            <div class="track-row" data-index="${t.index}" style="animation-delay:${i * 0.015}s">
                <div class="track-num">${i + 1}</div>
                <div class="track-cover-sm">
                    ${t.imageUrl ? `<img src="${t.imageUrl}" alt="" />` : `<div class="cover-ph-sm"><svg viewBox="0 0 24 24" width="12" height="12" fill="#535353"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`}
                    <div class="play-ov"><svg viewBox="0 0 24 24" width="13" height="13" fill="#1DB954"><path d="M8 5v14l11-7z"/></svg></div>
                </div>
                <div class="track-details">
                    <div class="track-title">${e(t.name)}</div>
                    <div class="track-artist">${e(t.artist)}</div>
                </div>
                <div class="track-dur">${t.duration}</div>
            </div>
        `).join('');

        this._view.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,sans-serif;background:#121212;color:#fff;overflow-x:hidden;user-select:none}
.container{padding:8px}

/* Tabs */
.tab-bar{display:flex;gap:6px;padding:2px 0 8px;position:sticky;top:0;z-index:10;background:#121212;align-items:center}
.tab{padding:5px 12px;border-radius:16px;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;border:none;color:#b3b3b3;background:#242424;letter-spacing:.2px}
.tab:hover{background:#303030;color:#fff}
.tab.active{background:#1DB954;color:#000}
.refresh-btn{margin-left:auto;padding:5px 8px;border-radius:16px;font-size:11px;cursor:pointer;border:none;background:#242424;color:#b3b3b3;transition:all .15s;display:flex;align-items:center;justify-content:center}
.refresh-btn:hover{background:#303030;color:#fff}

/* List Items */
.list-row{display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;cursor:pointer;transition:background .15s;animation:fadeIn .2s ease-out both}
.list-row:hover{background:rgba(255,255,255,.08)}
.list-cover{width:36px;height:36px;border-radius:4px;overflow:hidden;flex-shrink:0;box-shadow:0 1px 6px rgba(0,0,0,.3)}
.list-cover img{width:100%;height:100%;object-fit:cover}
.cover-ph{width:100%;height:100%;background:linear-gradient(135deg,#282828,#1a1a1a);display:flex;align-items:center;justify-content:center;color:#535353}
.list-info{flex:1;min-width:0}
.list-name{font-size:12px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list-meta{font-size:10px;color:#727272;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list-arrow{color:#535353;display:flex;align-items:center;flex-shrink:0;transition:color .15s}
.list-row:hover .list-arrow{color:#1DB954}
.list-row:hover .list-name{color:#1DB954}
.liked-cover-icon{width:36px;height:36px;border-radius:4px;background:linear-gradient(135deg,#450af5,#8e8ee5 60%,#1db954);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(69,10,245,.4);flex-shrink:0}
.liked-cover-detail{width:46px;height:46px;border-radius:6px;background:linear-gradient(135deg,#450af5,#8e8ee5 60%,#1db954);display:flex;align-items:center;justify-content:center;box-shadow:0 3px 12px rgba(69,10,245,.5);flex-shrink:0}
.liked-row .list-name{color:#fff;font-weight:700}
.liked-row:hover .list-name{color:#1ed760}

/* Track Detail Header */
.detail-header{padding:4px 0 8px;margin-bottom:6px;border-bottom:1px solid rgba(255,255,255,.06)}
.back-btn{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#b3b3b3;cursor:pointer;background:none;border:none;padding:4px 0;transition:color .15s;font-family:inherit;font-weight:500}
.back-btn:hover{color:#1DB954}
.detail-cover{display:flex;align-items:center;gap:10px;margin-top:8px}
.detail-cover img{width:46px;height:46px;border-radius:6px;box-shadow:0 3px 10px rgba(0,0,0,.4)}
.detail-cover-ph{width:46px;height:46px;border-radius:6px;background:linear-gradient(135deg,#282828,#1a1a1a);display:flex;align-items:center;justify-content:center;color:#535353}
.detail-info .d-name{font-size:13px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}
.detail-info .d-count{font-size:10px;color:#727272;margin-top:2px}

/* Track Rows in Detail */
.track-row{display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer;transition:background .12s;animation:fadeIn .2s ease-out both}
.track-row:hover{background:rgba(255,255,255,.08)}
.track-num{width:16px;text-align:right;font-size:10px;color:#6a6a6a;flex-shrink:0;font-variant-numeric:tabular-nums}
.track-row:hover .track-num{color:#1DB954}
.track-cover-sm{position:relative;width:28px;height:28px;border-radius:3px;overflow:hidden;flex-shrink:0}
.track-cover-sm img{width:100%;height:100%;object-fit:cover}
.cover-ph-sm{width:100%;height:100%;background:#282828;display:flex;align-items:center;justify-content:center;color:#535353}
.play-ov{position:absolute;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .12s}
.track-row:hover .play-ov{opacity:1}
.track-details{flex:1;min-width:0}
.track-title{font-size:11.5px;font-weight:500;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.track-row:hover .track-title{color:#1DB954}
.track-artist{font-size:10px;color:#727272;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}
.track-dur{font-size:10px;color:#6a6a6a;flex-shrink:0;font-variant-numeric:tabular-nums}

/* States */
.loading{display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px;color:#b3b3b3;font-size:11px}
.spinner{width:18px;height:18px;border:2px solid rgba(29,185,84,.2);border-top-color:#1DB954;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:24px;color:#666;font-size:11px}
@keyframes fadeIn{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:translateX(0)}}

/* count badge */
.count-badge{font-size:9px;color:#1DB954;background:rgba(29,185,84,.14);padding:1px 6px;border-radius:8px;font-weight:700;margin-left:4px}

/* Auth Card */
.auth-card{display:flex;flex-direction:column;align-items:center;text-align:center;padding:30px 18px;background:radial-gradient(circle at 50% 0%,rgba(29,185,84,0.14) 0%,rgba(20,20,20,0.85) 80%);border-radius:16px;border:1px solid rgba(255,255,255,0.08);box-shadow:0 10px 30px rgba(0,0,0,0.4);margin:6px 2px}
.auth-icon-badge{position:relative;width:52px;height:52px;margin-bottom:12px;display:flex;align-items:center;justify-content:center}
.auth-icon-glow{position:absolute;inset:-6px;background:radial-gradient(circle,rgba(29,185,84,0.45) 0%,transparent 70%);border-radius:50%;animation:authPulse 3s ease-in-out infinite alternate}
@keyframes authPulse{from{transform:scale(0.9);opacity:0.5}to{transform:scale(1.15);opacity:0.95}}
.auth-icon-inner{position:relative;width:44px;height:44px;background:linear-gradient(135deg,#222,#121212);border:1px solid rgba(29,185,84,0.4);border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(0,0,0,0.6)}
.auth-title{font-size:14px;font-weight:700;color:#fff;margin-bottom:5px;letter-spacing:-0.2px}
.auth-desc{font-size:11px;color:#8e8e8e;margin-bottom:18px;line-height:1.45;max-width:220px}
.auth-btn{width:100%;max-width:180px;padding:9px 14px;background:#1DB954;color:#000;font-weight:700;font-size:12px;border:none;border-radius:20px;cursor:pointer;transition:all 0.2s cubic-bezier(0.4,0,0.2,1);box-shadow:0 4px 14px rgba(29,185,84,0.35);display:flex;align-items:center;justify-content:center;gap:6px}
.auth-btn:hover{background:#1ed760;transform:translateY(-1px);box-shadow:0 6px 20px rgba(29,185,84,0.5)}
.auth-btn-secondary{margin-top:8px;background:transparent;border:none;color:#666;font-size:10.5px;cursor:pointer;transition:color 0.15s;padding:3px}
.auth-btn-secondary:hover{color:#aaa;text-decoration:underline}
</style></head>
<body>
<div class="container">
    ${!token ? `
    <!-- AUTH REQUIRED VIEW -->
    <div class="auth-card">
        <div class="auth-icon-badge">
            <div class="auth-icon-glow"></div>
            <div class="auth-icon-inner">
                <svg viewBox="0 0 24 24" width="26" height="26" fill="#1DB954"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5.49 14.41c-.22.36-.68.47-1.04.25-2.85-1.74-6.44-2.14-10.67-1.17-.41.09-.82-.16-.91-.57-.09-.41.16-.82.57-.91 4.63-1.06 8.62-.61 11.8 1.34.36.21.48.67.25 1.06zm1.46-3.26c-.28.45-.87.59-1.32.31-3.26-2.01-8.23-2.59-12.08-1.42-.51.15-1.05-.14-1.2-.65-.15-.51.14-1.05.65-1.2 4.41-1.34 9.89-.69 13.64 1.63.45.29.59.88.31 1.33zm.13-3.39C15.18 7.42 8.78 7.2 5.12 8.31c-.6.18-1.23-.17-1.41-.77-.18-.6.17-1.23.77-1.41 4.22-1.28 11.29-1.03 15.77 1.63.54.32.72 1.02.4 1.56-.32.54-1.02.72-1.57.4z"/></svg>
            </div>
        </div>
        <div class="auth-title">Spotify Login Required</div>
        <div class="auth-desc">Connect your Spotify account to view and stream your playlists and albums.</div>
        <button class="auth-btn" onclick="signIn()">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="#000"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5.49 14.41c-.22.36-.68.47-1.04.25-2.85-1.74-6.44-2.14-10.67-1.17-.41.09-.82-.16-.91-.57-.09-.41.16-.82.57-.91 4.63-1.06 8.62-.61 11.8 1.34.36.21.48.67.25 1.06zm1.46-3.26c-.28.45-.87.59-1.32.31-3.26-2.01-8.23-2.59-12.08-1.42-.51.15-1.05-.14-1.2-.65-.15-.51.14-1.05.65-1.2 4.41-1.34 9.89-.69 13.64 1.63.45.29.59.88.31 1.33zm.13-3.39C15.18 7.42 8.78 7.2 5.12 8.31c-.6.18-1.23-.17-1.41-.77-.18-.6.17-1.23.77-1.41 4.22-1.28 11.29-1.03 15.77 1.63.54.32.72 1.02.4 1.56-.32.54-1.02.72-1.57.4z"/></svg>
            <span>Log In with Spotify</span>
        </button>
        <button class="auth-btn-secondary" onclick="manualSignIn()">Enter Token Manually</button>
    </div>
    ` : `
    ${this.showingTracks ? `
    <!-- TRACK DETAIL VIEW -->
    <div class="detail-header">
        <button class="back-btn" onclick="goBack()"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg> Back to ${e(this.activeTab === 'playlists' ? 'Playlists' : 'Albums')}</button>
        <div class="detail-cover">
            ${this.selectedListId === 'liked-songs' || this.selectedListImage === 'liked-gradient'
                ? `<div class="liked-cover-detail"><svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg></div>`
                : this.selectedListImage
                    ? `<img src="${this.selectedListImage}" alt="" />`
                    : `<div class="detail-cover-ph"><svg viewBox="0 0 24 24" width="24" height="24" fill="#535353"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`
            }
            <div class="detail-info">
                <div class="d-name">${e(this.selectedListName)}</div>
                <div class="d-count">${this.tracks.length} tracks</div>
            </div>
        </div>
    </div>
    ${this.isLoadingTracks
        ? `<div class="loading"><div class="spinner"></div><span>Loading tracks...</span></div>`
        : this.trackError
            ? `<div class="empty" style="color:#ff6b6b;padding:16px 8px">
                <div style="margin-bottom:10px;line-height:1.4">${e(this.trackError)}</div>
                <button class="auth-btn-secondary" onclick="manualSignIn()" style="font-size:11px;padding:6px 14px;cursor:pointer">🔑 Enter Fresh Token</button>
               </div>`
            : this.tracks.length > 0
                ? trackListHtml
                : `<div class="empty">No tracks found in this ${this.activeTab === 'playlists' ? 'playlist' : 'album'}</div>`
    }
    ` : `
    <!-- LIST VIEW -->
    <div class="tab-bar">
        <button class="tab ${this.activeTab === 'playlists' ? 'active' : ''}" onclick="switchTab('playlists')">Playlists</button>
        <button class="tab ${this.activeTab === 'albums' ? 'active' : ''}" onclick="switchTab('albums')">Albums</button>
        <button class="refresh-btn" onclick="refresh()" title="Refresh"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>
    </div>
    ${listItems.length > 0 ? `<div style="font-size:9.5px;color:#666;padding:0 0 6px;text-transform:uppercase;letter-spacing:.8px">${this.activeTab} <span class="count-badge">${listItems.length}</span></div>` : ''}
    ${this.isLoading
        ? `<div class="loading"><div class="spinner"></div><span>Loading ${this.activeTab}...</span></div>`
        : listItems.length > 0
            ? listHtml
            : `<div class="empty">No ${this.activeTab} found.<br/>Click refresh to load.</div>`
    }
    `}
    `}
</div>
<script>
const vscode = acquireVsCodeApi();
function signIn(){vscode.postMessage({command:'signIn'})}
function manualSignIn(){vscode.postMessage({command:'manualSignIn'})}
function switchTab(tab){vscode.postMessage({command:'switchTab',tab})}
function refresh(){vscode.postMessage({command:'refresh'})}
function goBack(){vscode.postMessage({command:'back'})}

document.addEventListener('click', function(e) {
    const listRow = e.target.closest('.list-row');
    if (listRow) {
        const id = listRow.getAttribute('data-id');
        const name = listRow.getAttribute('data-name');
        const image = listRow.getAttribute('data-image') || '';
        const isPlaylist = '${this.activeTab}' === 'playlists';
        if (isPlaylist) {
            vscode.postMessage({ command: 'selectPlaylist', id, name, image });
        } else {
            vscode.postMessage({ command: 'selectAlbum', id, name, image });
        }
        return;
    }

    const trackRow = e.target.closest('.track-row');
    if (trackRow) {
        const idx = parseInt(trackRow.getAttribute('data-index') || '0', 10);
        vscode.postMessage({ command: 'playTrack', index: idx });
        return;
    }
});
</script>
</body></html>`;
    }

    private escapeHtml(text: string): string {
        return (text || '')
            .replace(/&/g,'&amp;')
            .replace(/</g,'&lt;')
            .replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;')
            .replace(/'/g,'&#039;');
    }
}
