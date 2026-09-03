import * as os from 'os';
import { Memento, workspace } from 'vscode';

import { BUTTON_ID_SIGN_IN, BUTTON_ID_SIGN_OUT } from '../consts/consts';
import { getState } from '../store/store';

export function getConfig() {
    return workspace.getConfiguration('spotify');
}

export function isWebApiSpotifyClient() {
    // Default to Web API for all platforms — works with any device (phone, browser, desktop).
    // Users who specifically want local-only D-Bus/AppleScript can set forceWebApiImplementation to false.
    return true;
}

export function isButtonToBeShown(buttonId: string): boolean {
    const shouldShow = getConfig().get(`show${buttonId[0].toUpperCase()}${buttonId.slice(1)}`, false);
    const { loginState } = getState();

    if (buttonId === `${BUTTON_ID_SIGN_IN}Button`) {
        return shouldShow && !loginState;
    } else if (buttonId === `${BUTTON_ID_SIGN_OUT}Button`) {
        return shouldShow && !!loginState;
    }

    return shouldShow;
}

export function getButtonPriority(buttonId: string): number {
    const config = getConfig();
    return config.get('priorityBase', 0) + config.get(`${buttonId}Priority`, 0);
}

export function getStatusCheckInterval(): number {
    const isWebApiClient = isWebApiSpotifyClient();
    // Local clients (AppleScript / D-Bus) are free to poll fast. The Web API client
    // hits api.spotify.com every tick and shares one app-wide rate limit across all
    // users, so it gets a higher floor.
    const configured = getConfig().get<number>('statusCheckInterval', isWebApiClient ? 3000 : 1500);
    if (isWebApiClient) {
        return Math.max(configured, 2000);
    }
    return configured;
}

export function getLyricsServerUrl(): string {
    return getConfig().get<string>('lyricsServerUrl', '');
}

export function getAuthServerUrl(): string {
    return getConfig().get<string>('authServerUrl', '') || 'https://resound.krisnarhesa.dev';
}

export function getClientId(): string {
    return getConfig().get<string>('clientId', '');
}

export function getSpotifyApiUrl(): string {
    return getConfig().get<string>('spotifyApiUrl', '');
}

export function openPanelLyrics(): number {
    return getConfig().get<number>('openPanelLyrics', 1);
}

export function getTrackInfoFormat(): string {
    return getConfig().get<string>('trackInfoFormat', '');
}

export function getForceWebApiImplementation(): boolean {
    return getConfig().get<boolean>('forceWebApiImplementation', false);
}

export function getEnableLogs(): boolean {
    return getConfig().get<boolean>('enableLogs', false);
}

export type TrackInfoClickBehaviour = 'none' | 'focus_song' | 'play_pause';

export function getTrackInfoClickBehaviour(): TrackInfoClickBehaviour {
    return getConfig().get<TrackInfoClickBehaviour>('trackInfoClickBehaviour', 'focus_song');
}

let globalState: Memento;

export function registerGlobalState(memento: Memento) {
    globalState = memento;
}

const LAST_USED_PORT = 'lastUsedPort';

export function getLastUsedPort() {
    return globalState.get<number>(LAST_USED_PORT);
}

export function setLastUsedPort(port: number) {
    globalState.update(LAST_USED_PORT, port);
}
