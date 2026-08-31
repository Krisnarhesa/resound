import { Api, getApi } from '@vscodespotify/spotify-common/lib/spotify/api';
import { Playlist, Track } from '@vscodespotify/spotify-common/lib/spotify/consts';
import autobind from 'autobind-decorator';
import { commands, Uri, window } from 'vscode';
import * as crypto from 'crypto';

function base64UrlEncode(str: Buffer): string {
    return str.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

function generateCodeVerifier(): string {
    return base64UrlEncode(crypto.randomBytes(32));
}

import { createDisposableAuthSever } from '../auth/server/local';
import { getAuthServerUrl, getClientId, getConfig } from '../config/spotify-config';
import { SIGN_IN_COMMAND } from '../consts/consts';
import { log, showInformationMessage, showWarningMessage, showErrorMessage } from '../info/info';
import { isAlbum } from '../isAlbum';
import { DUMMY_PLAYLIST, ILoginState, ISpotifyStatusState, Album } from '../state/state';
import { getState, getStore } from '../store/store';
import { artistsToArtist, cleanToken } from '../utils/utils';
import fetch from 'node-fetch';
import { URLSearchParams } from 'url';
import {
    UpdateStateAction,
    UPDATE_STATE_ACTION,
    PlaylistsLoadAction,
    PLAYLISTS_LOAD_ACTION,
    AlbumLoadAction,
    ALBUM_LOAD_ACTION,
    SelectPlaylistAction,
    SELECT_PLAYLIST_ACTION,
    SelectAlbumAction,
    SELECT_ALBUM_ACTION,
    SelectTrackAction,
    SELECT_TRACK_ACTION,
    TracksLoadAction,
    TRACKS_LOAD_ACTION,
    SignInAction,
    SIGN_IN_ACTION,
    SignOutAction,
    SIGN_OUT_ACTION
} from './common';

export function withApi() {
    return (_target: any, _key: any, descriptor: PropertyDescriptor) => {
        const originalMethod = descriptor.value;

        descriptor.value = function(...args: any[]) {
            const api = getSpotifyWebApi();
            if (api) {
                return originalMethod.apply(this, [...args, api]);
            } else {
                (async () => {
                    const signIn = 'Sign in';
                    const result = await showWarningMessage('You should be logged in order to use this feature.', signIn);
                    if (result === signIn) {
                        commands.executeCommand(SIGN_IN_COMMAND);
                    }
                })();
            }
        };

        return descriptor;
    };
}

export function withErrorAsync() {
    return (_target: any, _key: any, descriptor: PropertyDescriptor) => {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            try {
                return await originalMethod.apply(this, args);
            } catch (e: any) {
                if (e && e.message && (e.message.includes('NO_ACTIVE_DEVICE') || e.message.includes('404'))) {
                    showWarningMessage('No active Spotify device found. Please open Spotify on your Desktop or Mobile app and play a song to activate it.');
                } else {
                    showWarningMessage('Failed to perform operation ' + (e.message || e));
                }
            }
        };

        return descriptor;
    };
}

function actionCreator() {
    return (_target: any, _key: any, descriptor: PropertyDescriptor) => {
        const originalMethod = descriptor.value;

        descriptor.value = function (...args: any[]) {
            try {
                const action = originalMethod.apply(this, args);
                if (action && typeof action === 'object' && typeof action.type === 'string') {
                    getStore().dispatch(action);
                }
            } catch (e: any) {
                // silent
            }
        };

        return descriptor;
    };
}

function asyncActionCreator() {
    return (_target: any, _key: any, descriptor: PropertyDescriptor) => {
        const originalMethod = descriptor.value;

        descriptor.value = async function(...args: any[]) {
            try {
                const action = await originalMethod.apply(this, args);
                if (action && typeof action === 'object' && typeof action.type === 'string') {
                    getStore().dispatch(action);
                }
            } catch (e: any) {
                // silent
            }
        };

        return descriptor;
    };
}

const apiMap = new WeakMap<ILoginState, Api>();
export const getSpotifyWebApi = () => {
    const { loginState } = getState();
    if (!loginState) {
        log('getSpotifyWebApi', 'NOT LOGGED IN');
        return null;
    }
    if (!window.state.focused) {
        log('getSpotifyWebApi', 'NOT FOCUSED');
        return null;
    }
    let api = apiMap.get(loginState);
    if (!api) {
        api = getApi(getAuthServerUrl(), loginState.accessToken, loginState.refreshToken, (token: string) => {
            actionsCreator._actionSignIn(token, loginState.refreshToken);
        });
        apiMap.set(loginState, api);
    }
    return api;
};

class ActionCreator {
    @autobind
    @actionCreator()
    updateStateAction(state: Partial<ISpotifyStatusState>): UpdateStateAction {
        return {
            type: UPDATE_STATE_ACTION,
            state
        };
    }

    @autobind
    @asyncActionCreator()
    async loadPlaylists(): Promise<PlaylistsLoadAction> {
        const state = getState();
        const token = cleanToken(state.loginState?.accessToken);
        if (token) {
            try {
                const res = await fetch('https://api.spotify.com/v1/me/playlists?limit=50', {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                });
                if (res.ok) {
                    const data: any = await res.json();
                    const playlists = (data.items || []).filter(Boolean).map((p: any) => ({
                        id: p.id,
                        name: p.name,
                        uri: p.uri,
                        images: p.images || [],
                        owner: p.owner || { id: '', display_name: '' },
                        tracks: { total: p.tracks?.total || 0 }
                    }));
                    return {
                        type: PLAYLISTS_LOAD_ACTION,
                        playlists
                    };
                }
            } catch { /* silent */ }
        }
        return {
            type: PLAYLISTS_LOAD_ACTION,
            playlists: []
        };
    }

    @autobind
    @asyncActionCreator()
    async loadAlbums(): Promise<AlbumLoadAction> {
        const state = getState();
        const token = cleanToken(state.loginState?.accessToken);
        if (token) {
            try {
                const res = await fetch('https://api.spotify.com/v1/me/albums?limit=50', {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                });
                if (res.ok) {
                    const data: any = await res.json();
                    const albums = (data.items || []).filter((i: any) => i && i.album).map((item: any) => ({
                        album: {
                            id: item.album.id,
                            name: item.album.name,
                            uri: item.album.uri,
                            images: item.album.images || [],
                            artists: item.album.artists || [],
                            total_tracks: item.album.total_tracks || 0
                        }
                    }));
                    return {
                        type: ALBUM_LOAD_ACTION,
                        albums
                    };
                }
            } catch { /* silent */ }
        }
        return {
            type: ALBUM_LOAD_ACTION,
            albums: []
        };
    }

    @autobind
    @actionCreator()
    selectPlaylistAction(p: Playlist): SelectPlaylistAction {
        return {
            type: SELECT_PLAYLIST_ACTION,
            playlist: p
        };
    }

    @autobind
    @actionCreator()
    selectAlbumAction(album: Album): SelectAlbumAction {
        return {
            type: SELECT_ALBUM_ACTION,
            album
        };
    }

    @autobind
    @actionCreator()
    selectTrackAction(track: Track): SelectTrackAction {
        return {
            type: SELECT_TRACK_ACTION,
            track
        };
    }

    @autobind
    selectCurrentTrack() {
        const state = getState();
        if (state.playerState && state.track) {
            let track: Track;
            const currentTrack = state.track;
            const playlist = state.playlists.find(p => {
                const tracks = state.tracks.get(p.id);
                if (tracks) {
                    const foundTrack = tracks.find(t => t.track.name === currentTrack.name
                        && t.track.album.name === currentTrack.album
                        && artistsToArtist(t.track.artists) === currentTrack.artist);

                    if (foundTrack) {
                        track = foundTrack;
                        return true;
                    }
                }
                return false;
            });

            if (playlist) {
                this.selectPlaylistAction(playlist);
                this.selectTrackAction(track!);
            }
        }
    }

    @autobind
    loadTracksForSelectedPlaylist(): void {
        this.loadTracks(getState().selectedList);
    }

    @autobind
    loadTracksIfNotLoaded(list: Playlist | Album): void {
        if (!list) {
            return void 0;
        }
        const { tracks } = getState();
        if (!tracks.has(isAlbum(list) ? list.album.id : list.id)) {
            this.loadTracks(list);
        }
    }

    @autobind
    @asyncActionCreator()
    async loadTracks(list?: Playlist | Album): Promise<TracksLoadAction | undefined> {
        if (!list || (!isAlbum(list) && list.id === DUMMY_PLAYLIST.id)) {
            return void 0;
        }

        const state = getState();
        const token = cleanToken(state.loginState?.accessToken);

        if (token) {
            try {
                const listId = isAlbum(list) ? list.album.id : list.id;
                const isPl = !isAlbum(list);
                const endpoint = isPl
                    ? `https://api.spotify.com/v1/playlists/${listId}`
                    : `https://api.spotify.com/v1/albums/${listId}`;

                let data: any = null;
                const res = await fetch(endpoint, {
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
                });

                if (res.ok) {
                    data = await res.json();
                } else if (res.status === 401 || res.status === 403) {
                    const newToken = await refreshAccessToken();
                    if (newToken) {
                        const retryRes = await fetch(endpoint, {
                            headers: { 'Authorization': `Bearer ${newToken}`, 'Content-Type': 'application/json' }
                        });
                        if (retryRes.ok) {
                            data = await retryRes.json();
                        }
                    }
                }

                if (data) {
                    const rawItems: any[] = Array.isArray(data.items?.items)
                        ? data.items.items
                        : (Array.isArray(data.tracks?.items)
                            ? data.tracks.items
                            : (Array.isArray(data.items)
                                ? data.items
                                : (Array.isArray(data.tracks) ? data.tracks : [])));

                    const tracks = rawItems.map((rawItem: any) => {
                        const track = rawItem?.item || rawItem?.track || rawItem;
                        return {
                            track: {
                                id: track.id,
                                name: track.name,
                                uri: track.uri || `spotify:track:${track.id}`,
                                album: track.album || { id: listId, name: (list as any).name || '' },
                                artists: track.artists || []
                            }
                        };
                    }).filter(t => t.track.id && t.track.name);

                    return {
                        type: TRACKS_LOAD_ACTION,
                        list,
                        tracks
                    };
                }
            } catch (e) {
                // fallback
            }
        }

        return void 0;
    }

    @autobind
    @withErrorAsync()
    @withApi()
    async playTrack(offset: number, list: Playlist | Album, api?: Api): Promise<undefined> {
        await api!.player.play.put({
            offset,
            albumUri: isAlbum(list) ? list.album.uri : list.uri
        });
        return;
    }

    @autobind
    @withErrorAsync()
    @withApi()
    async seekTo(time: string, api?: Api): Promise<void> {
        const timeS = time || await window.showInputBox({ prompt: 'Select time to seek to in format mm:ss or ss' });
        if (!timeS) {
            return;
        }
        const invalidTimeFormatError = 'Invalid time format. Should be in format mm:ss or ss';
        const timeA = timeS.split(':');
        if (timeA.length > 2) {
            showErrorMessage(invalidTimeFormatError);
            return;
        }
        let minutes = 0;
        let seconds = 0;
        if (timeA[1]){
            minutes = parseFloat(timeA[0]);
            seconds = parseFloat(timeA[1]);
        } else {
            seconds = parseFloat(timeA[0]);
        }

        if (Number.isNaN(seconds) || Number.isNaN(minutes)){
            showErrorMessage(invalidTimeFormatError);
            return;
        }

        const seekTo = Math.round((minutes * 60 + seconds) * 1000);

        await api!.player.seek.put(seekTo);
    }

    @autobind
    async actionSignIn() {
        const { createServerPromise, dispose } = createDisposableAuthSever();
        const authServerUrl = getAuthServerUrl() || 'https://resound.krisnarhesa.dev';

        commands.executeCommand('vscode.open', Uri.parse(`${authServerUrl}/login`)).then(() => {
            createServerPromise.then(({ accessToken, refreshToken }) => {
                this._actionSignIn(accessToken, refreshToken);
                showInformationMessage('ReSound: Berhasil login ke Spotify!');
                dispose();
            }).catch(e => {
                const errMsg = typeof e === 'string' ? e : JSON.stringify(e);
                showErrorMessage(`Gagal login: ${errMsg}`);
                dispose();
            });
        });
    }

    @autobind
    @actionCreator()
    _actionSignIn(accessToken: string, refreshToken: string): SignInAction {
        return {
            accessToken,
            refreshToken,
            type: SIGN_IN_ACTION
        };
    }

    @autobind
    @actionCreator()
    actionSignOut(): SignOutAction {
        return {
            type: SIGN_OUT_ACTION
        };
    }
}

export const actionsCreator = new ActionCreator();

export async function refreshAccessToken(): Promise<string | null> {
    const state = getState();
    const refreshToken = state.loginState?.refreshToken;
    const authServerUrl = getAuthServerUrl() || 'https://resound.krisnarhesa.dev';
    if (!refreshToken) { return null; }

    try {
        const res = await fetch(`${authServerUrl}/refresh_token?refresh_token=${encodeURIComponent(refreshToken)}`);
        if (res.ok) {
            const data: any = await res.json();
            const newAccessToken = data.access_token || data.accessToken;
            if (newAccessToken) {
                const newRefreshToken = data.refresh_token || data.refreshToken || refreshToken;
                actionsCreator._actionSignIn(newAccessToken, newRefreshToken);
                return newAccessToken;
            }
        }
    } catch { /* silent */ }
    return null;
}


