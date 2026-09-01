import autobind from 'autobind-decorator';

import { actionsCreator } from './actions/actions';
import { getStatusCheckInterval } from './config/spotify-config';
import { SpoifyClientSingleton } from './spotify/spotify-client';
import { CANCELED_REASON } from './spotify/utils';

export class SpotifyStatusController {
    private _retryCount: number;
    private _cancelCb?: () => void;
    /**
     * How many sequential errors is needed to hide all buttons
     */
    private _maxRetryCount: number;

    constructor() {
        this._retryCount = 0;
        this._maxRetryCount = 5;
        this.queryStatus();
    }

    /**
     * Retrieves status of spotify and passes it to spotifyStatus;
     */
    @autobind
    queryStatus() {
        this._cancelPreviousPoll();
        const { promise, cancel } = SpoifyClientSingleton.getSpotifyClient(this.queryStatus).pollStatus(status => {
            actionsCreator.updateStateAction(status);
            this._retryCount = 0;
        }, getStatusCheckInterval);
        this._cancelCb = cancel;
        promise.catch(this.clearState);
    }

    dispose() {
        this._cancelPreviousPoll();
    }

    private clearState = (reason: any) => {
        // canceling of the promise only happens when method queryStatus is triggered.
        if (reason !== CANCELED_REASON) {
            this._retryCount++;
            if (this._retryCount >= this._maxRetryCount) {
                actionsCreator.updateStateAction({
                    playerState: {
                        position: 0, volume: 0, state: 'paused', isRepeating: false,
                        isShuffling: false
                    },
                    track: { album: '', artist: '', name: '' },
                    isRunning: false
                });
                // We do NOT reset retry count to 0 here so we can use it for backoff
            }
            
            const baseInterval = getStatusCheckInterval();
            let delay = baseInterval;
            
            // If it's a rate limit (429) or repeated errors, back off significantly
            const isRateLimit = reason && (reason.status === 429 || (reason.response && reason.response.status === 429) || (reason.message && reason.message.includes('429')));
            
            if (isRateLimit || this._retryCount >= this._maxRetryCount) {
                // Exponential backoff: base * 2^retry, max 5 minutes (300000ms)
                const backoffMultiplier = Math.min(Math.pow(2, this._retryCount - this._maxRetryCount), 60);
                delay = Math.min(baseInterval * backoffMultiplier, 300000);
                if (isRateLimit) {
                    delay = Math.max(delay, 60000); // At least 1 minute wait for 429
                }
            }
            
            setTimeout(this.queryStatus, delay);
        }
    };

    private _cancelPreviousPoll() {
        if (this._cancelCb) {
            this._cancelCb();
        }
    }
}
