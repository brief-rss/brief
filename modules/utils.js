//@ts-strict
// ===== Promise utilities =====

/**
 * Adapt setTimeout for Promises
 * @param {number} [delay]
 * @returns {Promise<void>}
 */
export function wait(delay) {
    return new Promise(resolve => setTimeout(() => resolve(), delay));
}

/** @return {Promise<null>} */
function microtask() {
    return Promise.resolve(null); // `await` always enqueues a microtask to resume in
}

/**
 * Wait for a specific event (for example, 'transitionend')
 * @param {EventTarget} element
 * @param {string} event
 */
export function expectedEvent(element, event) {
    return new Promise((resolve) => {
        element.addEventListener(event, resolve, {once: true, passive: true});
    });
}

/**
 * @param {XMLHttpRequest} request
 */
export function xhrPromise(request) {
    return new Promise((resolve, reject) => {
        request.onload = () => resolve(request.response);
        request.onerror = e => reject(e);
        request.onabort = e => reject(e);
        request.send();
    });
}

// ===== Misc helpers =====

/**
 * @param {string} id
 * @returns {HTMLElement | null}
 */
export function getElement(id) { return document.getElementById(id); }

/**
 * @param {number} delay
 * @param {() => void} callback
 */
export function debounced(delay, callback) {
    let active = false;

    return async () => {
        if(active === true) {
            return;
        }
        active = true;
        wait(delay).then(() => {
            active = false;
            callback();
        });
    };
}

/**
 * Iterate nodes in a XPathResult
 * @param {XPathResult} result
 */
export function iterSnapshot(result) {
    return {
        [Symbol.iterator]: function*() {
            for(let i = 0; i < result.snapshotLength; i++){
                yield result.snapshotItem(i);
            }
        }
    };
}

/**
 * @template T
 * @param {T[] | T} v
 * @returns {T[]}
 */
export function asArray(v) {
    if(Array.isArray(v)) {
        return v;
    } else {
        return [v];
    }
}

/**
 * @param {string} date
 * @returns {number?}
 */
export function parseDateValue(date) {
    // TODO: maybe MIL timezones here?
    if(!date) {
        return null;
    }
    return (new Date(date)).getTime();
}

/** @param {string} str */
export async function hashString(str) {
    let enc = new TextEncoder();
    let buffer = await crypto.subtle.digest('SHA-1', enc.encode(str));
    let u8arr = new Uint8Array(buffer);
    return Array.from(u8arr).map(b => ('00' + b.toString(16)).slice(-2)).join('');
}

export class RelativeDate {
    /** @param {number} aAbsoluteTime */
    constructor(aAbsoluteTime) {
        this.currentDate = new Date();
        this.currentTime = this.currentDate.getTime() - this.currentDate.getTimezoneOffset() * 60000;

        this.targetDate = new Date(aAbsoluteTime);
        this.targetTime = this.targetDate.getTime() - this.targetDate.getTimezoneOffset() * 60000;
    }

    get deltaMinutes() { return this._getDelta(60000); }
    get deltaMinuteSteps() { return this._getSteps(60000); }

    get deltaHours() { return this._getDelta(3600000); }
    get deltaHourSteps() { return this._getSteps(3600000); }

    get deltaDays() { return this._getDelta(86400000); }
    get deltaDaySteps() { return this._getSteps(86400000); } //Unexact due to timezones

    get deltaYears() { return this._getDelta(31536000000); }
    get deltaYearSteps() {
        return (this.currentDate.getFullYear() -
                this.targetDate.getFullYear());
    }

    /** @param {number} aDivisor */
    _getSteps(aDivisor) {
        let current = Math.ceil(this.currentTime / aDivisor);
        let target = Math.ceil(this.targetTime / aDivisor);
        return current - target;
    }

    /** @param {number} aDivisor */
    _getDelta(aDivisor) {
        return Math.floor((this.currentTime - this.targetTime) / aDivisor);
    }
}

/**
 * @param {number} number
 * @param {string} forms
 */
export function getPluralForm(number, forms) {
    let knownForms = browser.i18n.getMessage('pluralRule').split(';');
    let rules = new Intl.PluralRules();
    let form = rules.select(number);
    return forms.split(';')[knownForms.indexOf(form)];
}

/** @param {string} url */
export async function openBackgroundTab(url) {
    let tab = await browser.tabs.getCurrent();
    try {
        await browser.tabs.create({active: false, url: url, openerTabId: tab.id});
    }
    catch(/** @type {any} */e) { // FIXME any better way?
        if(e.message.includes("openerTabId")) {
            await browser.tabs.create({active: false, url: url});
        } else {
            throw e;
        }
    }
}

// ===== Messaging helpers =====
export let Comm = {
    master: false,
    verbose: false,
    /** @type {Set<(message: any) => any>} */
    observers: new Set(),

    initMaster() {
        this.master = true;
        browser.runtime.onMessage.addListener(/** @param {any} message */ message => this._notify(message));
    },

    /** @param {any} message */
    _notify(message) {
        if(this.verbose) {
            console.log('Comm', message);
        }
        switch(message._type) {
            case 'broadcast-tx':
                message._type = 'broadcast';
                return Promise.all([
                    this._notifyObservers(message).catch(() => undefined),
                    browser.runtime.sendMessage(message).catch(() => undefined),
                ]).then(([local, remote]) => local !== undefined ? local : remote);
            case 'master':
                return this._notifyObservers(message);
            default:
                throw new Error("Unknown Comm message direction");
        }
    },

    /** @param {any} message */
    async _notifyObservers(message) {
        await microtask();
        let answer = undefined;
        for(let listener of this.observers) {
            let reply = listener(message);
            if(reply !== undefined) {
                answer = reply;
            }
        }
        return answer;
    },

    /** @param {any} message */
    _send(message) {
        if(this.master) {
            return this._notify(message);
        } else {
            return browser.runtime.sendMessage(message);
        }
    },

    /**
     * @param {Partial<HandlerTypes>} handlers
     */
    registerObservers(handlers) {
        /** @type {(message: any) => any} */
        let listener = message => {
            let {id, _type, payload} = /** @type {{_type: string, id: keyof HandlerTypes, payload: any}} */(message);
            if(_type !== 'broadcast' && (_type !== 'master' || !this.master)) {
                return;
            }
            /** @type {any} */
            let handler = handlers[id];
            if(handler) {
                return handler(...payload);
            }
        };
        if(Comm.master) {
            Comm.observers.add(listener);
        } else {
            browser.runtime.onMessage.addListener(listener);
        }
        return listener;
    },

    /** @param {(message: any) => any} listener */
    dropObservers(listener) {
        if(Comm.master) {
            Comm.observers.delete(listener);
        } else {
            browser.runtime.onMessage.removeListener(listener);
        }
    },

    /**
     * @template {keyof HandlerTypes} ID
     * @param {ID} id
     * @param {Parameters<HandlerTypes[ID]>} payload
     * @returns {Promise<ReturnType<HandlerTypes[ID]>?>}
     */
    broadcast(id, ...payload) {
        return Comm._send({id, payload, _type: 'broadcast-tx'});
    },

    /**
     * @template {keyof HandlerTypes} ID
     * @param {ID} id
     * @param {Parameters<HandlerTypes[ID]>} payload
     * @returns {Promise<ReturnType<HandlerTypes[ID]>>}
     */
    callMaster(id, ...payload) {
        return Comm._send({id, payload, _type: 'master'});
    },
};

/**
 * @typedef {import("/modules/database.js").Feed} Feed
 * @typedef {import("/modules/database.js").FeedUpdate} FeedUpdate
 */

/**
 * FIXME get rid of `any` here
 * @typedef {object} HandlerTypes
 * @property {(arg: {feeds: any}) => void} entries-expire
 * @property {(arg: {feeds: any, entries: any, changes: any}) => void} entries-updated
 * @property {(arg: {feeds: any, options: any}) => void} feedlist-add
 * @property {(arg: {feeds: Feed | Feed[]}) => void} feedlist-delete
 * @property {() => Feed[]} feedlist-get
 * @property {(arg: {updates: (FeedUpdate | FeedUpdate[])}) => void} feedlist-modify
 * @property {(arg: {feeds: Feed[]}) => void} feedlist-updated
 * @property {() => Promise<boolean>} is-options-window-open
 * @property {(arg: {name: string, value: string | boolean | number, actionName: any}) => void} set-pref
 * @property {() => void} style-updated
 * @property {(arg: {feed: {url: string}}) => (string[])} subscribe-add-feed
 * @property {(arg: {windowId: number}) => ({url: string?, linkTitle: string?}[])} subscribe-get-feeds
 * @property {() => void} update-all
 * @property {(arg: {feeds: string[]}) => void} update-feeds
 * @property {() => void} update-query-status
 * @property {(arg: {active: boolean, underway: string[], progress: number}) => void} update-status
 * @property {() => void} update-stop
 */
