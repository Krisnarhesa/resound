import { ExtensionContext, window } from 'vscode';

import { createCommands } from './commands';
import { SpotifyStatus } from './components/spotify-status';
import { SearchWebviewProvider } from './components/search-webview';
import { NowPlayingWebviewProvider } from './components/nowplaying-webview';
import { LibraryWebviewProvider } from './components/library-webview';
import { registerGlobalState } from './config/spotify-config';
import { SpotifyStatusController } from './spotify-status-controller';
import { SpoifyClientSingleton } from './spotify/spotify-client';
import { getStore } from './store/store';

// This method is called when your extension is activated. Activation is
// controlled by the activation events defined in package.json.
export function activate(context: ExtensionContext) {
    // This line of code will only be executed once when your extension is activated.
    registerGlobalState(context.globalState);
    getStore(context.globalState);
    const spotifyStatus = new SpotifyStatus();
    const controller = new SpotifyStatusController();

    // Webview providers
    const nowPlayingProvider = new NowPlayingWebviewProvider();
    const searchWebviewProvider = new SearchWebviewProvider();
    const libraryProvider = new LibraryWebviewProvider();

    context.subscriptions.push(
        window.registerWebviewViewProvider('resound-nowplaying', nowPlayingProvider),
        window.registerWebviewViewProvider('resound-search', searchWebviewProvider),
        window.registerWebviewViewProvider('resound-library', libraryProvider),
        nowPlayingProvider,
        controller,
        spotifyStatus,
        createCommands(SpoifyClientSingleton.getSpotifyClient(), searchWebviewProvider, nowPlayingProvider, libraryProvider)
    );
}
