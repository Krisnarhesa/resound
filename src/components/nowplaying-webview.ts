import {
    CancellationToken,
    WebviewView,
    WebviewViewProvider,
    WebviewViewResolveContext,
    commands
} from 'vscode';
import fetch from 'node-fetch';
import { getState, getStore } from '../store/store';
import { cleanToken } from '../utils/utils';
import { favoritesManager } from '../utils/favorites-manager';
import { spotifyFetch } from '../utils/spotify-fetch';

export interface SyncedLyricLine {
    timeMs: number;
    text: string;
}

export class NowPlayingWebviewProvider implements WebviewViewProvider {
    public static readonly viewType = 'resound-nowplaying';

    private _view?: WebviewView;
    private currentTrackKey: string = '';
    private currentTrackId: string = '';
    private trackName: string = '';
    private artistName: string = '';
    private albumName: string = '';
    private albumArt: string = '';
    private lyrics: SyncedLyricLine[] = [];
    private isLoadingLyrics: boolean = false;
    private storeUnsub: (() => void) | undefined;
    private isPlaying: boolean = false;
    private isShuffle: boolean = false;
    private isLiked: boolean = false;
    private albumArtFetchedFor: string = '';
    private progressMs: number = 0;
    private durationMs: number = 0;

    constructor() {
        // Driven entirely by the shared status poller (spotify-status-controller):
        // on Linux/macOS that's a free local OS query, on Windows the single Web API
        // /me/player poll. No independent polling here — zero extra API calls.
        this.storeUnsub = getStore().subscribe(() => this.onStoreChange());
    }

    /** re-read the store and push the current track/progress to the webview */
    public triggerFetch() {
        this.onStoreChange();
    }

    public dispose() {
        if (this.storeUnsub) { this.storeUnsub(); this.storeUnsub = undefined; }
    }

    private onStoreChange() {
        if (!this._view || !this._view.visible) { return; }
        try {
            const state = getState();
            const track = state?.track;
            const player = state?.playerState;
            const trackName = track?.name || '';
            const artistName = track?.artist || '';
            if (!trackName && !artistName) { return; }

            this.isPlaying = player?.state === 'playing';
            if (typeof player?.position === 'number' && player.position > 0) {
                this.progressMs = player.position;
            }
            if (track?.durationMs) { this.durationMs = track.durationMs; }
            this.isShuffle = !!player?.isShuffling;

            const newKey = `${artistName} - ${trackName}`;
            const trackChanged = newKey !== this.currentTrackKey && newKey !== ' - ';
            this.isLiked = favoritesManager.isLiked(track?.id || this.currentTrackId, trackName, artistName);

            if (trackChanged) {
                this.currentTrackKey = newKey;
                this.currentTrackId = track?.id || '';
                this.trackName = trackName;
                this.artistName = artistName;
                this.albumName = track?.album || '';
                this.albumArt = track?.imageUrl || '';
                this.lyrics = [];
                this.isLoadingLyrics = true;
                this.progressMs = player?.position || 0;
                this.updateWebview();

                if (!this.albumArt && this.albumArtFetchedFor !== newKey) {
                    this.albumArtFetchedFor = newKey;
                    this.fetchAlbumArt(artistName, trackName);
                }
                this.fetchLyrics(artistName, trackName);
            } else if (this._view) {
                this._view.webview.postMessage({
                    command: 'updatePlayback',
                    progressMs: this.progressMs,
                    durationMs: this.durationMs,
                    isPlaying: this.isPlaying,
                    isShuffle: this.isShuffle,
                    isLiked: this.isLiked
                });
            }
        } catch (e) { /* silent */ }
    }

    public getIsPlaying(): boolean {
        return this.isPlaying;
    }

    public resolveWebviewView(
        webviewView: WebviewView,
        _context: WebviewViewResolveContext,
        _token: CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) { this.triggerFetch(); }
        });

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (['previous', 'playPause', 'next', 'seek', 'toggleShuffle', 'toggleLike'].includes(message.command)) {
                await this.handleControlCommand(message);
            }
        });

        this.updateWebview();
        this.triggerFetch();
    }

    private async handleControlCommand(message: any) {
        const command = message.command;
        const state = getState();
        const token = cleanToken(state.loginState?.accessToken);

        if (token) {
            try {
                if (command === 'previous') {
                    await spotifyFetch('https://api.spotify.com/v1/me/player/previous', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                } else if (command === 'next') {
                    await spotifyFetch('https://api.spotify.com/v1/me/player/next', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                } else if (command === 'seek') {
                    await spotifyFetch(`https://api.spotify.com/v1/me/player/seek?position_ms=${message.positionMs}`, {
                        method: 'PUT',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    this.progressMs = message.positionMs;
                } else if (command === 'playPause') {
                    const endpoint = this.isPlaying
                        ? 'https://api.spotify.com/v1/me/player/pause'
                        : 'https://api.spotify.com/v1/me/player/play';
                    await spotifyFetch(endpoint, { method: 'PUT' });
                    this.isPlaying = !this.isPlaying;
                } else if (command === 'toggleShuffle') {
                    const nextShuffle = !this.isShuffle;
                    this.isShuffle = nextShuffle;
                    await spotifyFetch(`https://api.spotify.com/v1/me/player/shuffle?state=${nextShuffle}`, {
                        method: 'PUT',
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                } else if (command === 'toggleLike') {
                    let targetId = this.currentTrackId;
                    if (!targetId && this.trackName) {
                        try {
                            const searchRes = await spotifyFetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(this.trackName + ' ' + this.artistName)}&type=track&limit=1`, {
                                headers: { 'Authorization': `Bearer ${token}` }
                            });
                            if (searchRes.ok) {
                                const sData: any = await searchRes.json();
                                targetId = sData?.tracks?.items?.[0]?.id || '';
                                if (targetId) { this.currentTrackId = targetId; }
                            }
                        } catch { /* search ignore */ }
                    }

                    const fallbackId = targetId || `track-${Date.now()}`;
                    const currentlyLiked = favoritesManager.isLiked(fallbackId, this.trackName, this.artistName);

                    if (currentlyLiked) {
                        await favoritesManager.removeFavorite(fallbackId, token);
                        this.isLiked = false;
                    } else {
                        const totalSec = Math.floor((this.durationMs || 0) / 1000);
                        const min = Math.floor(totalSec / 60);
                        const sec = totalSec % 60;
                        const durationStr = min + ':' + (sec < 10 ? '0' : '') + sec;

                        await favoritesManager.addFavorite({
                            id: fallbackId,
                            uri: targetId ? `spotify:track:${targetId}` : '',
                            name: this.trackName || 'Unknown Track',
                            artist: this.artistName || 'Unknown Artist',
                            album: this.albumName || 'Liked Songs',
                            imageUrl: this.albumArt || '',
                            duration: durationStr
                        }, token);
                        this.isLiked = true;
                    }

                    this.updateWebview();
                    commands.executeCommand('resound.refreshLibrary');
                }
            } catch (e) {
                if (command === 'previous') { await commands.executeCommand('resound.previous'); }
                else if (command === 'next') { await commands.executeCommand('resound.next'); }
                else if (command === 'playPause') { await commands.executeCommand('resound.playPause'); }
            }
        } else {
            if (command === 'previous') { await commands.executeCommand('resound.previous'); }
            else if (command === 'next') { await commands.executeCommand('resound.next'); }
            else if (command === 'playPause') { await commands.executeCommand('resound.playPause'); }
        }

        this.triggerFetch();
    }

    private async fetchAlbumArt(artist: string, title: string) {
        try {
            const state = getState();
            const token = cleanToken(state.loginState?.accessToken);
            if (!token) { return; }

            const res = await spotifyFetch(
                `https://api.spotify.com/v1/search?q=${encodeURIComponent(`${artist} ${title}`)}&type=track&limit=1`
            );

            if (res.ok) {
                const data: any = await res.json();
                const images = data?.tracks?.items?.[0]?.album?.images;
                if (images && images.length > 0) {
                    this.albumArt = images[0].url;
                    this.updateWebview();
                }
            }
        } catch (e) { /* silent */ }
    }

    private async fetchLyrics(artist: string, title: string) {
        if (!artist || !title) { return; }
        this.isLoadingLyrics = true;

        const cleanTitle = title.replace(/\s*-\s*.*$/, '').replace(/\(.*?\)/g, '').trim();
        const cleanArtist = artist.split(',')[0].trim();

        try {
            const res = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(cleanArtist)}&track_name=${encodeURIComponent(cleanTitle)}`);
            if (res.ok) {
                const data: any = await res.json();
                if (data.syncedLyrics) {
                    this.lyrics = this.parseLrc(data.syncedLyrics);
                    this.isLoadingLyrics = false;
                    this.updateWebview();
                    return;
                } else if (data.plainLyrics) {
                    this.lyrics = data.plainLyrics.split('\n').filter((l: string) => l.trim()).map((l: string) => ({
                        timeMs: -1,
                        text: l.trim()
                    }));
                    this.isLoadingLyrics = false;
                    this.updateWebview();
                    return;
                }
            }
        } catch (e) { /* fallback */ }

        try {
            const searchRes = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(`${cleanArtist} ${cleanTitle}`)}`);
            if (searchRes.ok) {
                const results: any = await searchRes.json();
                if (Array.isArray(results) && results.length > 0) {
                    const best = results.find((r: any) => r.syncedLyrics) || results[0];
                    if (best && best.syncedLyrics) {
                        this.lyrics = this.parseLrc(best.syncedLyrics);
                        this.isLoadingLyrics = false;
                        this.updateWebview();
                        return;
                    } else if (best && best.plainLyrics) {
                        this.lyrics = best.plainLyrics.split('\n').filter((l: string) => l.trim()).map((l: string) => ({
                            timeMs: -1,
                            text: l.trim()
                        }));
                        this.isLoadingLyrics = false;
                        this.updateWebview();
                        return;
                    }
                }
            }
        } catch (e) { /* fallback */ }

        this.lyrics = [{ timeMs: -1, text: 'Lyrics not found for this track.' }];
        this.isLoadingLyrics = false;
        this.updateWebview();
    }

    private parseLrc(lrc: string): SyncedLyricLine[] {
        const lines = lrc.split('\n');
        const result: SyncedLyricLine[] = [];
        const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;

        for (const line of lines) {
            const match = line.match(regex);
            if (match) {
                const min = parseInt(match[1], 10);
                const sec = parseInt(match[2], 10);
                const msStr = match[3].padEnd(3, '0').slice(0, 3);
                const ms = parseInt(msStr, 10);
                const timeMs = (min * 60 + sec) * 1000 + ms;
                const text = match[4].trim();
                if (text) {
                    result.push({ timeMs, text });
                }
            }
        }
        return result;
    }

    private updateWebview() {
        if (!this._view) { return; }

        const lyricsHtml = this.isLoadingLyrics
            ? '<div class="lyrics-loading"><div class="spinner"></div><span>Loading lyrics...</span></div>'
            : this.lyrics.length > 0
                ? this.lyrics.map((line) =>
                    `<p class="lyric-line" data-time="${line.timeMs}">${this.escapeHtml(line.text)}</p>`
                ).join('')
                : '<p class="lyric-line empty">No lyrics available</p>';

        const albumArtHtml = this.albumArt
            ? `<img src="${this.albumArt}" alt="" class="album-art" />`
            : `<div class="album-art placeholder"><svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg></div>`;

        this._view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    html, body {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: #121212;
        color: #fff;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        user-select: none;
    }

    .app-wrapper {
        display: flex;
        flex-direction: column;
        height: 100%;
        padding: 8px;
        gap: 8px;
    }

    /* ORIGINAL SPOTIFY VERTICAL CARD */
    .player-card {
        flex-shrink: 0;
        background: linear-gradient(180deg, #183324 0%, #111a14 100%);
        border: 1px solid rgba(29, 185, 84, 0.22);
        border-radius: 12px;
        padding: 12px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    /* 1. Track Info (Full Width) */
    .player-header {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .album-art {
        width: 48px;
        height: 48px;
        border-radius: 8px;
        object-fit: cover;
        flex-shrink: 0;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
        background: #1e1e1e;
    }

    .album-art.placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        color: #444;
    }

    .track-meta {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
    }

    .track-title {
        font-size: 13.5px;
        font-weight: 700;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.3;
    }

    .artist-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 3px;
    }

    .track-artist {
        font-size: 11.5px;
        font-weight: 600;
        color: #1DB954;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
    }

    /* Equalizer */
    .eq-mini {
        display: flex;
        align-items: flex-end;
        gap: 2px;
        height: 11px;
        flex-shrink: 0;
    }
    .eq-bar {
        width: 2.5px;
        background: #1DB954;
        border-radius: 1px;
        animation: eqBounce 1s ease-in-out infinite alternate;
    }
    .eq-bar:nth-child(1) { height: 40%; animation-delay: 0.1s; }
    .eq-bar:nth-child(2) { height: 100%; animation-delay: 0.3s; }
    .eq-bar:nth-child(3) { height: 60%; animation-delay: 0.2s; }
    .eq-bar:nth-child(4) { height: 80%; animation-delay: 0.4s; }
    @keyframes eqBounce { 0% { height: 20%; } 100% { height: 100%; } }

    /* 2. Progress Bar Row */
    .progress-bar-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .time-lbl {
        font-size: 10px;
        color: #888;
        font-variant-numeric: tabular-nums;
        min-width: 26px;
    }
    .time-lbl.right { text-align: right; }

    .progress-slider {
        -webkit-appearance: none;
        flex: 1;
        height: 4px;
        background: rgba(255, 255, 255, 0.18);
        border-radius: 2px;
        outline: none;
        cursor: pointer;
    }
    .progress-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 11px;
        height: 11px;
        background: #fff;
        border-radius: 50%;
        cursor: pointer;
        box-shadow: 0 1px 4px rgba(0,0,0,0.6);
        margin-top: -3.5px;
    }
    .progress-slider::-webkit-slider-runnable-track {
        height: 4px;
        border-radius: 2px;
    }

    /* 3. Controls (Centered 5-button Bar: Shuffle, Prev, Play/Pause, Next, Favorite) */
    .controls-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 14px;
        padding-top: 2px;
    }

    .btn-ctrl {
        background: transparent;
        border: none;
        color: #b3b3b3;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.15s ease;
        position: relative;
    }
    .btn-ctrl:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.1);
        transform: scale(1.12);
    }
    .btn-ctrl:active { transform: scale(0.9); }

    .btn-ctrl.active-green {
        color: #1DB954;
    }
    .btn-ctrl.active-green:hover {
        color: #1ed760;
    }
    .btn-ctrl.active-green::after {
        content: '';
        position: absolute;
        bottom: 2px;
        width: 3px;
        height: 3px;
        background: #1DB954;
        border-radius: 50%;
    }

    .btn-play {
        background: #1DB954;
        color: #000;
        width: 38px;
        height: 38px;
        border-radius: 50%;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 3px 14px rgba(29, 185, 84, 0.45);
        transition: all 0.15s ease;
    }
    .btn-play:hover {
        background: #1ed760;
        transform: scale(1.08);
        box-shadow: 0 4px 18px rgba(29, 185, 84, 0.7);
    }
    .btn-play:active { transform: scale(0.92); }

    /* 4. LYRICS CARD */
    .lyrics-card {
        flex: 1;
        min-height: 0;
        background: #161616;
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 12px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
    }

    .lyrics-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-bottom: 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        flex-shrink: 0;
    }

    .lyrics-title-group {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .lyrics-heading {
        font-size: 11.5px;
        font-weight: 700;
        color: #d1d1d1;
        letter-spacing: 0.2px;
    }

    .badge-live {
        font-size: 8.5px;
        font-weight: 700;
        color: #1DB954;
        background: rgba(29, 185, 84, 0.14);
        padding: 1px 6px;
        border-radius: 6px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    /* Lyrics Body Stream */
    .lyrics-scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 12px 2px;
        scroll-behavior: smooth;
        -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%);
        mask-image: linear-gradient(to bottom, transparent 0%, black 10%, black 90%, transparent 100%);
    }

    .lyrics-scroll::-webkit-scrollbar { width: 3px; }
    .lyrics-scroll::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 3px; }

    .lyric-line {
        font-size: 12.5px;
        line-height: 1.55;
        color: rgba(255, 255, 255, 0.32);
        margin-bottom: 8px;
        transition: all 0.22s ease;
        cursor: default;
        padding: 4px 8px;
        border-radius: 6px;
    }

    .lyric-line.active {
        color: #ffffff;
        font-size: 13.5px;
        font-weight: 700;
        background: rgba(29, 185, 84, 0.14);
        border-left: 3px solid #1DB954;
        text-shadow: 0 0 12px rgba(29, 185, 84, 0.6);
        transform: translateX(2px);
    }

    .lyric-line.empty {
        color: #666;
        font-style: italic;
        font-size: 11.5px;
        text-align: center;
        padding: 24px 0;
    }

    .lyrics-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 24px 0;
        color: #888;
        font-size: 11.5px;
    }

    .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(29, 185, 84, 0.2);
        border-top-color: #1DB954;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
    }

    /* Idle View */
    .idle-view {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 30px 14px;
    }
    .idle-glow-badge {
        position: relative;
        width: 60px;
        height: 60px;
        margin-bottom: 14px;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .idle-ambient-glow {
        position: absolute;
        inset: -8px;
        background: radial-gradient(circle, rgba(29, 185, 84, 0.35) 0%, transparent 70%);
        border-radius: 50%;
        animation: idlePulse 3.5s ease-in-out infinite alternate;
    }
    @keyframes idlePulse {
        from { transform: scale(0.85); opacity: 0.4; }
        to { transform: scale(1.2); opacity: 0.85; }
    }
    .idle-icon-disc {
        position: relative;
        width: 52px;
        height: 52px;
        background: linear-gradient(135deg, #1c1c1c, #0d0d0d);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6);
        animation: slowRotate 20s linear infinite;
    }
    @keyframes slowRotate {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }
    .vinyl-groove {
        position: absolute;
        inset: 6px;
        border: 1px dashed rgba(255, 255, 255, 0.12);
        border-radius: 50%;
    }
    .vinyl-center {
        width: 22px;
        height: 22px;
        background: linear-gradient(135deg, #222, #111);
        border: 1.5px solid #1DB954;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .idle-title { font-size: 14px; font-weight: 700; color: #fff; margin-bottom: 4px; letter-spacing: -0.2px; }
    .idle-desc { font-size: 11px; color: #777; max-width: 200px; line-height: 1.45; margin-bottom: 14px; }
    .idle-eq {
        display: flex;
        align-items: flex-end;
        gap: 3px;
        height: 14px;
        opacity: 0.6;
    }
    .eq-idle-bar {
        width: 3px;
        background: #1DB954;
        border-radius: 2px;
        animation: eqPulse 1.2s ease-in-out infinite alternate;
    }
    .eq-idle-bar.b1 { height: 6px; animation-delay: 0s; }
    .eq-idle-bar.b2 { height: 12px; animation-delay: 0.25s; }
    .eq-idle-bar.b3 { height: 8px; animation-delay: 0.5s; }
    .eq-idle-bar.b4 { height: 14px; animation-delay: 0.15s; }
    .eq-idle-bar.b5 { height: 5px; animation-delay: 0.4s; }
    @keyframes eqPulse {
        from { transform: scaleY(0.4); }
        to { transform: scaleY(1); }
    }

    @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div class="app-wrapper">
    ${this.trackName ? `
    <!-- PLAYER CARD -->
    <div class="player-card">
        <!-- 1. Track Info on Top -->
        <div class="player-header">
            ${albumArtHtml}
            <div class="track-meta">
                <div class="track-title" title="${this.escapeHtml(this.trackName)}">${this.escapeHtml(this.trackName)}</div>
                <div class="artist-row">
                    <span class="track-artist">${this.escapeHtml(this.artistName)}</span>
                    <div class="eq-mini">
                        <div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 2. Progress Slider in Middle -->
        <div class="progress-bar-row">
            <span class="time-lbl" id="progressTime">${this.formatTime(this.progressMs)}</span>
            <input type="range" class="progress-slider" id="progressBar" min="0" max="${this.durationMs}" value="${this.progressMs}" onchange="seekTrack(this.value)" oninput="updateTimeText(this.value)">
            <span class="time-lbl right" id="durationTime">${this.formatTime(this.durationMs)}</span>
        </div>

        <!-- 3. Player Controls at Bottom (Shuffle, Prev, Play/Pause, Next, Favorite) -->
        <div class="controls-row">
            <!-- SHUFFLE BUTTON -->
            <button class="btn-ctrl ${this.isShuffle ? 'active-green' : ''}" id="shuffleBtn" onclick="sendCmd('toggleShuffle')" title="Shuffle (${this.isShuffle ? 'On' : 'Off'})">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.42l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.12z"/></svg>
            </button>

            <!-- PREVIOUS BUTTON -->
            <button class="btn-ctrl" onclick="sendCmd('previous')" title="Previous Track">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>

            <!-- PLAY / PAUSE BUTTON -->
            <button class="btn-play" id="playPauseBtn" onclick="sendCmd('playPause')" title="${this.isPlaying ? 'Pause' : 'Play'}">
                <svg id="playIcon" viewBox="0 0 24 24" width="20" height="20" fill="#000" style="display: ${this.isPlaying ? 'none' : 'block'};"><path d="M8 5v14l11-7z"/></svg>
                <svg id="pauseIcon" viewBox="0 0 24 24" width="20" height="20" fill="#000" style="display: ${this.isPlaying ? 'block' : 'none'};"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            </button>

            <!-- NEXT BUTTON -->
            <button class="btn-ctrl" onclick="sendCmd('next')" title="Next Track">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>

            <!-- FAVORITE / LIKE BUTTON -->
            <button class="btn-ctrl ${this.isLiked ? 'active-green' : ''}" id="likeBtn" onclick="sendCmd('toggleLike')" title="${this.isLiked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}">
                <svg id="likeIcon" viewBox="0 0 24 24" width="16" height="16" fill="${this.isLiked ? '#1DB954' : 'currentColor'}">
                    ${this.isLiked
                        ? `<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>`
                        : `<path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/>`
                    }
                </svg>
            </button>
        </div>
    </div>

    <!-- 4. LYRICS CARD -->
    <div class="lyrics-card">
        <div class="lyrics-top">
            <div class="lyrics-title-group">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="#1DB954"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
                <span class="lyrics-heading">Synced Lyrics</span>
            </div>
            <span class="badge-live">Live</span>
        </div>
        <div class="lyrics-scroll" id="lyricsBody">
            ${lyricsHtml}
        </div>
    </div>
    ` : `
    <!-- IDLE VIEW -->
    <div class="idle-view">
        <div class="idle-glow-badge">
            <div class="idle-ambient-glow"></div>
            <div class="idle-icon-disc">
                <div class="vinyl-groove"></div>
                <div class="vinyl-center">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="#1DB954">
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                    </svg>
                </div>
            </div>
        </div>
        <div class="idle-title">Ready to Play</div>
        <div class="idle-desc">Play any song on Spotify to see live synced lyrics & controls</div>
        <div class="idle-eq">
            <div class="eq-idle-bar b1"></div>
            <div class="eq-idle-bar b2"></div>
            <div class="eq-idle-bar b3"></div>
            <div class="eq-idle-bar b4"></div>
            <div class="eq-idle-bar b5"></div>
        </div>
    </div>
    `}
</div>

<script>
    const vscode = acquireVsCodeApi();
    let baseProgress = ${this.progressMs};
    let isPlaying = ${this.isPlaying};
    let isShuffle = ${this.isShuffle};
    let isLiked = ${this.isLiked};
    let lastSyncTime = performance.now();
    let currentActiveIdx = -1;

    function formatTime(ms) {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return min + ":" + (sec < 10 ? "0" : "") + sec;
    }

    function seekTrack(value) {
        vscode.postMessage({ command: "seek", positionMs: parseInt(value, 10) });
    }

    function updateTimeText(value) {
        const pt = document.getElementById("progressTime");
        if (pt) pt.innerText = formatTime(value);
    }

    function sendCmd(cmd) {
        if (cmd === 'playPause') {
            isPlaying = !isPlaying;
            lastSyncTime = performance.now();
            updatePlayPauseButton();
        } else if (cmd === 'toggleShuffle') {
            isShuffle = !isShuffle;
            updateShuffleButton();
        } else if (cmd === 'toggleLike') {
            isLiked = !isLiked;
            updateLikeButton();
        }
        vscode.postMessage({ command: cmd });
    }

    function updatePlayPauseButton() {
        const playIcon = document.getElementById('playIcon');
        const pauseIcon = document.getElementById('pauseIcon');
        const btn = document.getElementById('playPauseBtn');
        if (playIcon && pauseIcon) {
            playIcon.style.display = isPlaying ? 'none' : 'block';
            pauseIcon.style.display = isPlaying ? 'block' : 'none';
            if (btn) btn.title = isPlaying ? 'Pause' : 'Play';
        }
    }

    function updateShuffleButton() {
        const btn = document.getElementById('shuffleBtn');
        if (btn) {
            if (isShuffle) {
                btn.classList.add('active-green');
                btn.title = 'Shuffle (On)';
            } else {
                btn.classList.remove('active-green');
                btn.title = 'Shuffle (Off)';
            }
        }
    }

    function updateLikeButton() {
        const btn = document.getElementById('likeBtn');
        const icon = document.getElementById('likeIcon');
        if (btn && icon) {
            if (isLiked) {
                btn.classList.add('active-green');
                btn.title = 'Remove from Liked Songs';
                icon.setAttribute('fill', '#1DB954');
                icon.innerHTML = '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>';
            } else {
                btn.classList.remove('active-green');
                btn.title = 'Save to Liked Songs';
                icon.setAttribute('fill', 'currentColor');
                icon.innerHTML = '<path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/>';
            }
        }
    }

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.command === 'updatePlayback') {
            baseProgress = msg.progressMs;
            isPlaying = msg.isPlaying;
            if (typeof msg.isShuffle === 'boolean') { isShuffle = msg.isShuffle; }
            if (typeof msg.isLiked === 'boolean') { isLiked = msg.isLiked; }
            lastSyncTime = performance.now();
            updatePlayPauseButton();
            updateShuffleButton();
            updateLikeButton();

            const pb = document.getElementById("progressBar");
            const dt = document.getElementById("durationTime");
            if (pb && document.activeElement !== pb) {
                pb.max = msg.durationMs;
                pb.value = msg.progressMs;
                updateTimeText(msg.progressMs);
            }
            if (dt && msg.durationMs) {
                dt.innerText = formatTime(msg.durationMs);
            }

            syncLyrics();
        }
    });

    function getCurrentProgressMs() {
        if (!isPlaying) return baseProgress;
        const elapsed = performance.now() - lastSyncTime;
        return baseProgress + elapsed + 180;
    }

    function syncLyrics() {
        const container = document.getElementById('lyricsBody');
        if (!container) return;
        const lines = container.querySelectorAll('.lyric-line[data-time]');
        if (!lines || lines.length === 0) return;

        const currentMs = getCurrentProgressMs();
        let newActiveIdx = -1;

        for (let i = 0; i < lines.length; i++) {
            const time = parseInt(lines[i].getAttribute('data-time') || '-1', 10);
            if (time >= 0 && time <= currentMs) {
                newActiveIdx = i;
            } else if (time > currentMs) {
                break;
            }
        }

        if (newActiveIdx !== currentActiveIdx) {
            currentActiveIdx = newActiveIdx;
            lines.forEach((line, index) => {
                if (index === currentActiveIdx) {
                    line.classList.add('active');
                    line.scrollIntoView({ behavior: 'smooth', block: 'center' });
                } else {
                    line.classList.remove('active');
                }
            });
        }
    }

    function loop() {
        syncLyrics();
        
        const pb = document.getElementById("progressBar");
        if (pb && document.activeElement !== pb && isPlaying) {
            const currentMs = getCurrentProgressMs();
            if (currentMs <= parseInt(pb.max, 10)) {
                pb.value = currentMs;
                updateTimeText(currentMs);
            }
        }
        
        requestAnimationFrame(loop);
    }

    requestAnimationFrame(loop);
</script>
</body>
</html>`;
    }

    private formatTime(ms: number): string {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}:${sec.toString().padStart(2, "0")}`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
