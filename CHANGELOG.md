# Change Log

All notable changes to the "ReSound" extension will be documented in this file.

## [1.1.4] - 2026-09-03

### Added
- **Podcast & Episode Search Support**: The search panel now officially supports finding and playing Spotify podcast episodes. The results seamlessly blend music tracks and episodes.

### Fixed
- Fixed a critical "Null Pointer Exception" that caused the "Now Playing" status to crash when playing Podcasts, Local Files, or during the first second of a track transition. Handled safely using optional chaining.
## [1.1.3] - 2026-09-02

### Fixed
- "Log In with Spotify" now always uses the ReSound login server. The custom Client ID path is only used from the dedicated menu option.

## [1.1.2] - 2026-09-02

### Changed
- Rate-limit messages are now readable — "try again in 2h 2m" instead of "retry in 7340s" — and point to the "Use my own Spotify Client ID" option.

## [1.1.1] - 2026-09-02

### Changed
- **Now Playing panel no longer makes its own Spotify API calls.** It reads playback state from the shared status poller (a free local OS query on macOS/Linux, the single `/me/player` poll on Windows) and only fetches lyrics (from lrclib, not Spotify) on track change. Previously it polled `currently-playing` on its own timer. On Linux/macOS this drops the panel's Spotify request rate to **zero**.
- The Linux (D-Bus/MPRIS) client now also reports album art, track id, duration and playback position, so the panel has everything it needs without touching the Web API.

### Added
- **Optional: "Use my own Spotify Client ID"** in `ReSound: Sign In`. Default login is unchanged (through the ReSound server). If you configure your own app's Client ID, login runs PKCE straight to Spotify so your traffic uses your own rate-limit quota — useful if you keep hitting `HTTP 429`. Add `http://127.0.0.1:8350/callback` to the app's Redirect URIs. The ID is validated (32 hex), a "Reset to shared login" option appears once one is set, and a failed login offers to reset.

### Fixed
- Removed the internal circular import from 1.1.0 (`actions` ↔ `spotify-fetch`); token refresh now lives in a shared `auth/refresh` module.

## [1.1.0] - 2026-09-02

### Changed
- **Now Playing panel no longer polls when it is hidden or the window is unfocused.** It previously hit the Spotify API every 500 ms regardless. While active it now reconciles every 2.5 s when playing / 10 s when paused; the progress bar and lyrics keep updating smoothly between polls via local interpolation. Cuts background request volume by roughly 6–10x.
- Web API status-check interval default raised to 3 s (floor 2 s). The local (AppleScript / D-Bus) path is unchanged.

### Fixed
- All Spotify API calls now go through a single client that shares one rate-limit cooldown: after a `HTTP 429`, every panel and command backs off together until the `Retry-After` window passes, instead of each screen retrying on its own.
- Background status polling honours the `Retry-After` header on `429` rather than a fixed 60 s guess.
- Now Playing panel timer is disposed with the extension (no leaked interval).

## [1.0.5] - 2026-09-01

### Fixed
- Implemented intelligent exponential backoff in the background status polling mechanism. This prevents the extension from endlessly spamming the Spotify API with requests (which previously extended API rate limit bans infinitely) when a `HTTP 429` error is encountered.

## [1.0.4] - 2026-09-01

### Changed
- Replaced the extension icon with a premium classic black vinyl record featuring a bold Spotify green 'R' & 'S' monogram.
- Updated extension description to officially include Antigravity IDE support.


## [1.0.3] - 2026-09-01

### Fixed
- Fixed another occurrence of the `100 URI` limit bug in the global play command handler that caused `HTTP 400` and subsequent `HTTP 429` rate limits.


## [1.0.2] - 2026-09-01

### Fixed
- Fixed an issue where playing "Liked Songs" or large playlists would result in Spotify API `HTTP 400 Bad Request` and `HTTP 429 Too Many Requests` due to exceeding the 100 URI limit.

## [1.0.1] - 2026-09-01

### Changed
- Bumped version to satisfy VS Code Marketplace and OpenVSX registry constraints for initial public release.



## [1.0.0] - 2026-08-31

### Added
- Initial Release of ReSound
- Completely rebuilt the UI to use modern Webview Sidebars
- Added Real-time Synced Lyrics with 60FPS smooth scrolling
- Introduced a Premium Dark Mode and beautiful layout design
- Migrated authentication to custom server (resound.krisnarhesa.dev)
- Fixed context URI limitations for flawless playlist playback
- Cleaned up package.json and removed legacy command palette bloat
- Implemented The Ping-Pong OAuth Redirect flow for stealthy secure login
