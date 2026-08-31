import {
    CancellationToken,
    WebviewView,
    WebviewViewProvider,
    WebviewViewResolveContext,
    commands
} from 'vscode';
import fetch from 'node-fetch';
import { getState, getStore } from '../store/store';
import { cleanToken, parseSpotifyError } from '../utils/utils';

export interface SearchResult {
    id: string;
    name: string;
    artist: string;
    album: string;
    uri: string;
    imageUrl: string;
    duration: string;
}

export class SearchWebviewProvider implements WebviewViewProvider {
    public static readonly viewType = 'resound-search';

    private _view?: WebviewView;
    private searchResults: SearchResult[] = [];
    private lastQuery: string = '';
    private isSearching: boolean = false;
    private searchError: string = '';
    private lastToken: string = '';

    constructor() {
        getStore().subscribe(() => {
            const currentToken = getState().loginState?.accessToken || '';
            if (currentToken !== this.lastToken) {
                this.lastToken = currentToken;
                this.updateWebview();
            }
        });
    }

    public resolveWebviewView(
        webviewView: WebviewView,
        _context: WebviewViewResolveContext,
        _token: CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true
        };

        webviewView.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'search':
                    await this.performSearch(message.query);
                    break;
                case 'play':
                    const allUris = this.searchResults.map(r => r.uri);
                    await commands.executeCommand('resound.playSearchTrack', message.uri, message.index, allUris);
                    break;
                case 'signIn':
                    await commands.executeCommand('resound.signIn');
                    break;
                case 'manualSignIn':
                    await commands.executeCommand('resound.manualSignIn');
                    break;
            }
        });

        this.updateWebview();
    }

    public async triggerSearch(query?: any): Promise<void> {
        if (typeof query === 'string' && query.trim()) {
            await this.performSearch(query.trim());
        } else {
            if (this._view) {
                this._view.show(true);
                this._view.webview.postMessage({ command: 'focusSearch' });
            }
        }
    }

    private async performSearch(query: string) {
        if (!query || !query.trim()) {
            this.searchResults = [];
            this.lastQuery = '';
            this.isSearching = false;
            this.postResults();
            return;
        }

        this.lastQuery = query.trim();
        this.isSearching = true;
        this.searchError = '';
        this.postResults();

        const state = getState();
        const rawToken = state.loginState?.accessToken;
        const token = cleanToken(rawToken);

        if (!token) {
            this.isSearching = false;
            this.searchError = 'Login required. Please enter a valid Spotify token.';
            this.postResults();
            return;
        }

        try {
            const res = await fetch(
                `https://api.spotify.com/v1/search?q=${encodeURIComponent(this.lastQuery)}&type=track`,
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (res.status === 401) {
                this.searchError = 'Session expired or token invalid. Please enter a new token.';
                this.isSearching = false;
                this.postResults();
                return;
            }

            if (!res.ok) {
                const errMsg = await parseSpotifyError(res);
                throw new Error(errMsg);
            }

            const data: any = await res.json();
            const items = data?.tracks?.items || [];

            this.searchResults = items.map((item: any) => {
                const minutes = Math.floor(item.duration_ms / 60000);
                const seconds = Math.floor((item.duration_ms % 60000) / 1000);
                const images = item.album?.images || [];
                const smallImage = images.length > 0 ? images[images.length - 1].url : '';

                return {
                    id: item.id,
                    name: item.name,
                    artist: (item.artists || []).map((a: any) => a.name).join(', '),
                    album: item.album?.name || '',
                    uri: item.uri,
                    imageUrl: smallImage,
                    duration: `${minutes}:${seconds.toString().padStart(2, '0')}`
                };
            });
        } catch (e: any) {
            this.searchError = e?.message || 'Search failed';
        } finally {
            this.isSearching = false;
            this.postResults();
        }
    }

    private postResults() {
        if (!this._view) { return; }
        this._view.webview.postMessage({
            command: 'searchResults',
            results: this.searchResults,
            isSearching: this.isSearching,
            query: this.lastQuery,
            error: this.searchError
        });
    }

    private updateWebview() {
        if (!this._view) { return; }

        const state = getState();
        const token = cleanToken(state.loginState?.accessToken);

        this._view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        background: #121212;
        color: #fff;
        overflow-x: hidden;
        overflow-y: scroll;
        user-select: none;
    }

    .container { padding: 12px; }

    /* Search Bar */
    .search-bar {
        position: sticky;
        top: 0;
        z-index: 10;
        background: #121212;
        padding-bottom: 10px;
    }

    .search-input-wrapper {
        position: relative;
        display: flex;
        align-items: center;
    }

    .search-icon {
        position: absolute;
        left: 10px;
        color: #b3b3b3;
        display: flex;
        align-items: center;
        pointer-events: none;
    }

    .search-input {
        width: 100%;
        padding: 9px 12px 9px 34px;
        background: #242424;
        border: 2px solid transparent;
        border-radius: 20px;
        color: #fff;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: all 0.15s ease;
    }

    .search-input:focus {
        border-color: #1DB954;
        background: #2a2a2a;
    }

    .search-input::placeholder {
        color: #727272;
    }

    .search-spinner {
        position: absolute;
        right: 12px;
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-top-color: #1DB954;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
        display: none;
    }

    .search-spinner.active {
        display: block;
    }

    /* Results Header */
    .results-info {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 4px 8px 4px;
        font-size: 11px;
        font-weight: 600;
        color: #b3b3b3;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .results-count {
        background: #282828;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 10px;
        color: #1DB954;
    }

    /* Track List */
    .results-container {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .track-row {
        display: flex;
        align-items: center;
        padding: 7px 8px;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.12s ease;
        position: relative;
    }

    .track-row:hover {
        background: rgba(255, 255, 255, 0.08);
    }

    .track-row:active {
        transform: scale(0.98);
        background: rgba(29, 185, 84, 0.12);
    }

    .track-cover {
        width: 40px;
        height: 40px;
        border-radius: 4px;
        overflow: hidden;
        margin-right: 10px;
        flex-shrink: 0;
        position: relative;
        background: #282828;
    }

    .track-cover img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }

    .cover-placeholder {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #282828;
    }

    .play-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.12s ease;
    }

    .track-row:hover .play-overlay {
        opacity: 1;
    }

    .track-details {
        flex: 1;
        min-width: 0;
    }

    .track-title {
        font-size: 13px;
        font-weight: 500;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.3;
    }

    .track-meta {
        font-size: 11px;
        color: #b3b3b3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 2px;
    }

    .track-duration {
        font-size: 11px;
        color: #727272;
        margin-left: 8px;
        font-variant-numeric: tabular-nums;
    }

    /* States */
    .empty-state {
        text-align: center;
        padding: 30px 20px;
        color: #6a6a6a;
        font-size: 13px;
    }
    .empty-state.error {
        color: #ff5555;
    }

    .idle-state {
        text-align: center;
        padding: 30px 16px;
    }
    .idle-icon { display: flex; justify-content: center; margin-bottom: 10px; opacity: 0.4; }
    .idle-text { font-size: 12px; color: #535353; }

    /* Auth Card */
    .auth-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 30px 18px;
        background: radial-gradient(circle at 50% 0%, rgba(29, 185, 84, 0.14) 0%, rgba(20, 20, 20, 0.85) 80%);
        border-radius: 16px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
        margin: 6px 2px;
    }
    .auth-icon-badge {
        position: relative;
        width: 52px;
        height: 52px;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .auth-icon-glow {
        position: absolute;
        inset: -6px;
        background: radial-gradient(circle, rgba(29, 185, 84, 0.45) 0%, transparent 70%);
        border-radius: 50%;
        animation: authPulse 3s ease-in-out infinite alternate;
    }
    @keyframes authPulse {
        from { transform: scale(0.9); opacity: 0.5; }
        to { transform: scale(1.15); opacity: 0.95; }
    }
    .auth-icon-inner {
        position: relative;
        width: 44px;
        height: 44px;
        background: linear-gradient(135deg, #222, #121212);
        border: 1px solid rgba(29, 185, 84, 0.4);
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
    }
    .auth-title { font-size: 14px; font-weight: 700; color: #fff; margin-bottom: 5px; letter-spacing: -0.2px; }
    .auth-desc { font-size: 11px; color: #8e8e8e; margin-bottom: 18px; line-height: 1.45; max-width: 220px; }
    .auth-btn {
        width: 100%;
        max-width: 180px;
        padding: 9px 14px;
        background: #1DB954;
        color: #000;
        font-weight: 700;
        font-size: 12px;
        border: none;
        border-radius: 20px;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 4px 14px rgba(29, 185, 84, 0.35);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
    }
    .auth-btn:hover { background: #1ed760; transform: translateY(-1px); box-shadow: 0 6px 20px rgba(29, 185, 84, 0.5); }
    .auth-btn-secondary {
        margin-top: 8px;
        background: transparent;
        border: none;
        color: #666;
        font-size: 10.5px;
        cursor: pointer;
        transition: color 0.15s;
        padding: 3px;
    }
    .auth-btn-secondary:hover { color: #aaa; text-decoration: underline; }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }
</style>
</head>
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
        <div class="auth-desc">Connect your Spotify account to search tracks, albums, and stream music directly.</div>
        <button class="auth-btn" onclick="signIn()">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="#000"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5.49 14.41c-.22.36-.68.47-1.04.25-2.85-1.74-6.44-2.14-10.67-1.17-.41.09-.82-.16-.91-.57-.09-.41.16-.82.57-.91 4.63-1.06 8.62-.61 11.8 1.34.36.21.48.67.25 1.06zm1.46-3.26c-.28.45-.87.59-1.32.31-3.26-2.01-8.23-2.59-12.08-1.42-.51.15-1.05-.14-1.2-.65-.15-.51.14-1.05.65-1.2 4.41-1.34 9.89-.69 13.64 1.63.45.29.59.88.31 1.33zm.13-3.39C15.18 7.42 8.78 7.2 5.12 8.31c-.6.18-1.23-.17-1.41-.77-.18-.6.17-1.23.77-1.41 4.22-1.28 11.29-1.03 15.77 1.63.54.32.72 1.02.4 1.56-.32.54-1.02.72-1.57.4z"/></svg>
            <span>Log In with Spotify</span>
        </button>
        <button class="auth-btn-secondary" onclick="manualSignIn()">Enter Token Manually</button>
    </div>
    ` : `
    <!-- SEARCH VIEW -->
    <div class="search-bar">
        <div class="search-input-wrapper">
            <span class="search-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="#b3b3b3"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg></span>
            <input
                type="text"
                id="searchInput"
                class="search-input"
                placeholder="Search songs, artists..."
                autocomplete="off"
                spellcheck="false"
                oninput="handleInput(event)"
                onkeydown="handleKeydown(event)"
            />
            <div class="search-spinner" id="searchSpinner"></div>
        </div>
    </div>

    <div id="resultsInfo" class="results-info" style="display: none;">
        <span>Results</span>
        <span class="results-count" id="resultsCount">0</span>
    </div>

    <div class="results-container" id="resultsContainer">
        <div class="idle-state">
            <div class="idle-icon"><svg viewBox="0 0 24 24" width="36" height="36" fill="#b3b3b3"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg></div>
            <div class="idle-text">Search for songs or artists</div>
        </div>
    </div>
    `}
</div>

<script>
    const vscode = acquireVsCodeApi();
    let searchTimeout;

    function signIn() {
        vscode.postMessage({ command: 'signIn' });
    }

    function manualSignIn() {
        vscode.postMessage({ command: 'manualSignIn' });
    }

    function handleInput(e) {
        const query = e.target.value.trim();
        clearTimeout(searchTimeout);
        const spinner = document.getElementById('searchSpinner');
        
        if (query) {
            if (spinner) spinner.classList.add('active');
            searchTimeout = setTimeout(() => {
                vscode.postMessage({ command: 'search', query: query });
            }, 220); // Snappy 220ms debounce
        } else {
            if (spinner) spinner.classList.remove('active');
            vscode.postMessage({ command: 'search', query: '' });
        }
    }

    function handleKeydown(e) {
        if (e.key === 'Enter') {
            clearTimeout(searchTimeout);
            const query = e.target.value.trim();
            const spinner = document.getElementById('searchSpinner');
            if (spinner) spinner.classList.add('active');
            if (query) {
                vscode.postMessage({ command: 'search', query: query });
            }
        }
    }

    function playTrack(uri, index) {
        vscode.postMessage({ command: 'play', uri: uri, index: index });
    }

    function escapeHtml(text) {
        return (text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Dynamic DOM update without destroying input
    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.command === 'focusSearch') {
            const input = document.getElementById('searchInput');
            if (input) { input.focus(); input.select(); }
            return;
        }

        if (msg.command === 'searchResults') {
            const spinner = document.getElementById('searchSpinner');
            if (spinner && !msg.isSearching) spinner.classList.remove('active');

            const container = document.getElementById('resultsContainer');
            const info = document.getElementById('resultsInfo');
            const count = document.getElementById('resultsCount');

            if (!container) return;

            if (msg.isSearching) {
                if (spinner) spinner.classList.add('active');
                return;
            }

            if (msg.error) {
                if (info) info.style.display = 'none';
                container.innerHTML = '<div class="empty-state error">' + escapeHtml(msg.error) + '</div>';
                return;
            }

            if (msg.results && msg.results.length > 0) {
                if (info) info.style.display = 'flex';
                if (count) count.innerText = msg.results.length;

                container.innerHTML = msg.results.map((track, i) => \`
                    <div class="track-row" onclick="playTrack('\${escapeHtml(track.uri)}', \${i})">
                        <div class="track-cover">
                            \${track.imageUrl
                                ? \`<img src="\${track.imageUrl}" alt="" />\`
                                : \`<div class="cover-placeholder"><svg viewBox="0 0 24 24" width="18" height="18" fill="#535353"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>\`
                            }
                            <div class="play-overlay"><svg viewBox="0 0 24 24" width="16" height="16" fill="#1DB954"><path d="M8 5v14l11-7z"/></svg></div>
                        </div>
                        <div class="track-details">
                            <div class="track-title">\${escapeHtml(track.name)}</div>
                            <div class="track-meta">\${escapeHtml(track.artist)}</div>
                        </div>
                        <div class="track-duration">\${track.duration}</div>
                    </div>
                \`).join('');
            } else if (msg.query) {
                if (info) info.style.display = 'none';
                container.innerHTML = '<div class="empty-state">No results for "' + escapeHtml(msg.query) + '"</div>';
            } else {
                if (info) info.style.display = 'none';
                container.innerHTML = \`
                    <div class="idle-state">
                        <div class="idle-icon"><svg viewBox="0 0 24 24" width="36" height="36" fill="#b3b3b3"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg></div>
                        <div class="idle-text">Search for songs or artists</div>
                    </div>\`;
            }
        }
    });

    window.addEventListener('load', () => {
        const input = document.getElementById('searchInput');
        if (input) { setTimeout(() => input.focus(), 80); }
    });
</script>
</body>
</html>`;
    }
}
