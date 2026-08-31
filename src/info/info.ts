import * as moment from 'moment';
import { window } from 'vscode';

import { getEnableLogs } from '../config/spotify-config';

export function showInformationMessage(message: string) {
    window.showInformationMessage(`ReSound: ${message}`);
}

export function showWarningMessage(message: string, ...items: string[]) {
    return window.showWarningMessage(`ReSound: ${message}`, ...items);
}

export function showErrorMessage(message: string) {
    window.showErrorMessage(`ReSound: ${message}`, );
}

export function log(...args: any[]) {
    if (getEnableLogs()) {
        console.log.apply(console, ['resound', moment().format('YYYY/MM/DD HH:MM:mm:ss:SSS'), ...args]);
    }
}
