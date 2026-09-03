import { commands, Disposable, Uri, window } from 'vscode';

import { actionsCreator, getSpotifyWebApi, refreshAccessToken } from './actions/actions';
import { getTrackInfoClickBehaviour } from './config/spotify-config';
import { LyricsController } from './lyrics/lyrics';
import { SpotifyClient } from './spotify/common';
import { SpoifyClientSingleton } from './spotify/spotify-client';
import { Album, Playlist } from './state/state';
import { SIGN_IN_COMMAND } from './consts/consts';
import { SearchWebviewProvider } from './components/search-webview';
import { NowPlayingWebviewProvider } from './components/nowplaying-webview';
import { LibraryWebviewProvider } from './components/library-webview';
import { spotifyFetch } from './utils/spotify-fetch';
import { getState } from './store/store';
import { showWarningMessage, showInformationMessage } from './info/info';
import { cleanToken, parseSpotifyError } from './utils/utils';

export function createCommands(
    sC: SpotifyClient,
    searchWebviewProvider: SearchWebviewProvider,
    nowPlayingProvider?: NowPlayingWebviewProvider,
    libraryProvider?: LibraryWebviewProvider
): { dispose: () => void } {
    const lC = new LyricsController();

    const triggerUpdate = () => {
        if (nowPlayingProvider) {
            nowPlayingProvider.triggerFetch();
        }
    };

    const getClient = (): SpotifyClient => {
        return sC || SpoifyClientSingleton.getSpotifyClient();
    };

    const executeControl = async (endpoint: 'next' | 'previous' | 'play' | 'pause' | 'playPause') => {
        const state = getState();
        let token = cleanToken(state.loginState?.accessToken);
        let success = false;

        if (token) {
            try {
                const callApi = async (tok: string): Promise<boolean> => {
                    if (endpoint === 'next') {
                        const res = await spotifyFetch('https://api.spotify.com/v1/me/player/next', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${tok}` }
                        });
                        return res.ok || res.status === 204;
                    } else if (endpoint === 'previous') {
                        const res = await spotifyFetch('https://api.spotify.com/v1/me/player/previous', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${tok}` }
                        });
                        return res.ok || res.status === 204;
                    } else if (endpoint === 'play') {
                        const res = await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
                            method: 'PUT',
                            headers: { 'Authorization': `Bearer ${tok}` }
                        });
                        return res.ok || res.status === 204;
                    } else if (endpoint === 'pause') {
                        const res = await spotifyFetch('https://api.spotify.com/v1/me/player/pause', {
                            method: 'PUT',
                            headers: { 'Authorization': `Bearer ${tok}` }
                        });
                        return res.ok || res.status === 204;
                    } else if (endpoint === 'playPause') {
                        let isPlaying = nowPlayingProvider ? nowPlayingProvider.getIsPlaying() : false;
                        try {
                            const curRes = await spotifyFetch('https://api.spotify.com/v1/me/player/currently-playing', {
                                headers: { 'Authorization': `Bearer ${tok}` }
                            });
                            if (curRes.ok && curRes.status !== 204) {
                                const curData: any = await curRes.json();
                                if (typeof curData?.is_playing === 'boolean') {
                                    isPlaying = curData.is_playing;
                                }
                            }
                        } catch { /* ignore */ }

                        const targetUrl = isPlaying
                            ? 'https://api.spotify.com/v1/me/player/pause'
                            : 'https://api.spotify.com/v1/me/player/play';
                        const res = await spotifyFetch(targetUrl, {
                            method: 'PUT',
                            headers: { 'Authorization': `Bearer ${tok}` }
                        });
                        return res.ok || res.status === 204;
                    }
                    return false;
                };

                success = await callApi(token);

                if (!success) {
                    const newToken = await refreshAccessToken();
                    if (newToken) {
                        token = newToken;
                        success = await callApi(newToken);
                    }
                }
            } catch (e) {
                success = false;
            }
        }

        if (!success) {
            const client = getClient();
            if (client) {
                if (endpoint === 'next') { await client.next(); }
                else if (endpoint === 'previous') { await client.previous(); }
                else if (endpoint === 'play') { await client.play(); }
                else if (endpoint === 'pause') { await client.pause(); }
                else if (endpoint === 'playPause') { await client.playPause(); }
            }
        }

        triggerUpdate();
    };

    const regCmd = (name: string, callback: (...args: any[]) => any) => {
        return commands.registerCommand(`resound.${name}`, callback);
    };

    const lyrics = regCmd('lyrics', lC.findLyrics.bind(lC));
    const next = regCmd('next', () => executeControl('next'));
    const previous = regCmd('previous', () => executeControl('previous'));
    const play = regCmd('play', () => executeControl('play'));
    const pause = regCmd('pause', () => executeControl('pause'));
    const playPause = regCmd('playPause', () => executeControl('playPause'));
    
    const muteVolume = regCmd('muteVolume', () => getClient()?.muteVolume());
    const unmuteVolume = regCmd('unmuteVolume', () => getClient()?.unmuteVolume());
    const muteUnmuteVolume = regCmd('muteUnmuteVolume', () => getClient()?.muteUnmuteVolume());
    const volumeUp = regCmd('volumeUp', () => getClient()?.volumeUp());
    const volumeDown = regCmd('volumeDown', () => getClient()?.volumeDown());
    const toggleRepeating = regCmd('toggleRepeating', () => getClient()?.toggleRepeating());
    const toggleShuffling = regCmd('toggleShuffling', () => getClient()?.toggleShuffling());

    const signIn = regCmd('signIn', () => actionsCreator.actionSignIn());
    const signOut = regCmd('signOut', actionsCreator.actionSignOut);
    const manualSignIn = regCmd('manualSignIn', async () => {
        const { getConfig, getClientId } = await import('./config/spotify-config');
        const hasCustomClient = !!getClientId();

        const items: any[] = [
            {
                label: '$(zap) Log In with Spotify (Auto-Refresh Forever)',
                description: hasCustomClient ? 'Uses your configured Client ID' : 'Recommended: authorize once, tokens never expire',
                id: 'oauth'
            },
            {
                label: '$(key) Paste Spotify Access Token (1 Hour)',
                description: 'Temporary bearer token from Developer Dashboard',
                id: 'token'
            },
            {
                label: '$(gear) Use my own Spotify Client ID (own rate limit)',
                description: 'Advanced: log in against your own app from developer.spotify.com/dashboard',
                id: 'client_id'
            }
        ];
        if (hasCustomClient) {
            items.push({
                label: '$(discard) Reset to ReSound shared login',
                description: 'Clear the custom Client ID and use the default login',
                id: 'reset_client'
            });
        }

        const option = await window.showQuickPick(items, {
            placeHolder: 'Select Spotify Authentication Method'
        });

        if (!option) { return; }

        if (option.id === 'oauth') {
            await actionsCreator.actionSignIn();
        } else if (option.id === 'reset_client') {
            await getConfig().update('clientId', undefined, true);
            showInformationMessage('Reset to ReSound shared login. Logging in now.');
            await actionsCreator.actionSignIn();
        } else if (option.id === 'client_id') {
            const help = 'Open Spotify Dashboard';
            const pick = await window.showInformationMessage(
                'Create an app at developer.spotify.com/dashboard, add redirect URI http://127.0.0.1:8350/callback, then paste its Client ID.',
                help, 'I have my Client ID'
            );
            if (pick === help) {
                await commands.executeCommand('vscode.open', Uri.parse('https://developer.spotify.com/dashboard'));
            }
            if (!pick) { return; }
            const input = await window.showInputBox({
                prompt: 'Spotify Client ID (32 hex chars). Not the client secret, not a token.',
                placeHolder: 'e.g. 7d4981fa5e9b4661858a74e5b3c2d1a0',
                ignoreFocusOut: true,
                validateInput: (v) => /^[0-9a-f]{32}$/i.test(v.trim()) ? undefined : 'A Spotify Client ID is exactly 32 hex characters.'
            });
            if (input) {
                await getConfig().update('clientId', input.trim(), true);
                showInformationMessage('Client ID saved. Confirm http://127.0.0.1:8350/callback is in your app\'s Redirect URIs, then logging in now.');
                await actionsCreator.actionSignInWithClientId(input.trim());
            }
        } else if (option.id === 'token') {
            const input = await window.showInputBox({
                prompt: 'Enter your Spotify Access Token (Bearer Token)',
                placeHolder: 'Paste Spotify OAuth Token (e.g. from developer.spotify.com or OAuth server)',
                ignoreFocusOut: true
            });
            const sanitized = cleanToken(input);
            if (sanitized) {
                actionsCreator._actionSignIn(sanitized, '');
                showInformationMessage('ReSound: Successfully authenticated with Spotify Token!');
                triggerUpdate();
            }
        }
    });
    const loadPlaylists = regCmd('loadPlaylists', actionsCreator.loadPlaylists);
    const loadAlbums = regCmd('loadAlbums', actionsCreator.loadAlbums);
    const loadTracks = regCmd('loadTracks', actionsCreator.loadTracksForSelectedPlaylist);
    const searchTracks = regCmd('searchTracks', (query?: string) => searchWebviewProvider.triggerSearch(query));
    
    const playSearchTrack = regCmd('playSearchTrack', async (trackUri: string, index?: number, allUris?: string[]) => {
        if (trackUri) {
            try {
                const state = getState();
                const token = cleanToken(state.loginState?.accessToken);
                if (token) {
                    const startIndex = Math.max(0, index ?? 0);
                    const bodyData: any = (allUris && allUris.length > 0)
                        ? { uris: allUris.slice(startIndex, startIndex + 100), offset: { position: 0 } }
                        : { uris: [trackUri] };

                    const res = await spotifyFetch('https://api.spotify.com/v1/me/player/play', {
                        method: 'PUT',
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(bodyData)
                    });

                    if (!res.ok) {
                        const errMsg = await parseSpotifyError(res);
                        if (res.status === 404 || errMsg.includes('NO_ACTIVE_DEVICE')) {
                            showWarningMessage('No active Spotify device found. Please open Spotify on your Desktop/Phone and start playing a song first.');
                        } else {
                            showWarningMessage(`Failed to play track (HTTP ${res.status}): ${errMsg}`);
                        }
                    }
                } else {
                    const api = getSpotifyWebApi();
                    if (api) {
                        await api.player.play.put({ trackUri });
                    } else {
                        showWarningMessage('You should be logged in order to play search tracks.');
                        return;
                    }
                }
                const client = getClient();
                if (client && client.queryStatusFunc) {
                    client.queryStatusFunc();
                }
                triggerUpdate();
            } catch (e: any) {
                if (e.message && (e.message.includes('NO_ACTIVE_DEVICE') || e.message.includes('404'))) {
                    showWarningMessage('No active Spotify device found. Please open Spotify on your Desktop/Phone and start playing a song first.');
                } else {
                    showWarningMessage('Failed to play track: ' + (e.message || e));
                }
            }
        }
    });

    const trackInfoClick = regCmd('trackInfoClick', () => {
        const trackInfoClickBehaviour = getTrackInfoClickBehaviour();
        if (trackInfoClickBehaviour === 'focus_song') {
            actionsCreator.selectCurrentTrack();
        } else if (trackInfoClickBehaviour === 'play_pause') {
            executeControl('playPause');
        }
    });

    const playTrack = regCmd('playTrack', async (offset: number, list: Playlist | Album) => {
        await actionsCreator.playTrack(offset, list);
        const client = getClient();
        if (client && client.queryStatusFunc) {
            client.queryStatusFunc();
        }
        triggerUpdate();
    });

    const seekTo = regCmd('seekTo', (seekToMs: string) => {
        actionsCreator.seekTo(seekToMs);
    });

    const refreshLib = regCmd('refreshLibrary', async () => {
        if (libraryProvider) {
            await libraryProvider.refreshLibrary();
        }
    });

    return Disposable.from(
        lyrics,
        next,
        previous,
        play,
        pause,
        playPause,
        muteVolume,
        unmuteVolume,
        muteUnmuteVolume,
        volumeUp,
        volumeDown,
        toggleRepeating,
        toggleShuffling,
        signIn,
        signOut,
        manualSignIn,
        loadPlaylists,
        loadAlbums,
        loadTracks,
        searchTracks,
        playSearchTrack,
        trackInfoClick,
        playTrack,
        seekTo,
        refreshLib,
        lC.registration
    );
}
