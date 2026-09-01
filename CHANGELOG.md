# Change Log

All notable changes to the "ReSound" extension will be documented in this file.

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
