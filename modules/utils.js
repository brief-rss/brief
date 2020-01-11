// ===== Promise utilities =====

// Adapt setTimeout for Promises
export function wait(delay) {
    return new Promise(resolve => setTimeout(() => resolve(), delay));
}

function microtask() {
    return null; // `await` always enqueues a microtask to resume in
}

// Wait for a specific event (for example, 'transitionend')
export function expectedEvent(element, event) {
    return new Promise((resolve) => {
        element.addEventListener(event, resolve, {once: true, passive: true});
    });
}

export function xhrPromise(request) {
    return new Promise((resolve, reject) => {
        request.onload = () => resolve(request.response);
        request.onerror = e => reject(e);
        request.onabort = e => reject(e);
        request.send();
    });
}

// ===== Misc helpers =====

export function getElement(aId) { return document.getElementById(aId); }

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

// Iterate nodes in a XPathResult
export function iterSnapshot(result) {
    return {
        [Symbol.iterator]: function*() {
            for(let i = 0; i < result.snapshotLength; i++){
                yield result.snapshotItem(i);
            }
        }
    };
}

export function asArray(v) {
    if(Array.isArray(v)) {
        return v;
    } else {
        return [v];
    }
}

export function parseDateValue(date) {
    // TODO: maybe MIL timezones here?
    if(!date) {
        return;
    }
    return (new Date(date)).getTime();
}

export async function hashString(str) {
    let enc = new TextEncoder();
    let buffer = await crypto.subtle.digest('SHA-1', enc.encode(str));
    let u8arr = new Uint8Array(buffer);
    return Array.from(u8arr).map(b => ('00' + b.toString(16)).slice(-2)).join('');
}

export function RelativeDate(aAbsoluteTime) {
    this.currentDate = new Date();
    this.currentTime = this.currentDate.getTime() - this.currentDate.getTimezoneOffset() * 60000;

    this.targetDate = new Date(aAbsoluteTime);
    this.targetTime = this.targetDate.getTime() - this.targetDate.getTimezoneOffset() * 60000;
}

RelativeDate.prototype = {

    get deltaMinutes() { return this._getDelta(60000); },
    get deltaMinuteSteps() { return this._getSteps(60000); },

    get deltaHours() { return this._getDelta(3600000); },
    get deltaHourSteps() { return this._getSteps(3600000); },

    get deltaDays() { return this._getDelta(86400000); },
    get deltaDaySteps() { return this._getSteps(86400000); }, //Unexact due to timezones

    get deltaYears() { return this._getDelta(31536000000); },
    get deltaYearSteps() {
        return (this.currentDate.getFullYear() -
                this.targetDate.getFullYear());
    },

    _getSteps: function RelativeDate__getSteps(aDivisor) {
        let current = Math.ceil(this.currentTime / aDivisor);
        let target = Math.ceil(this.targetTime / aDivisor);
        return current - target;
    },

    _getDelta: function RelativeDate__getDelta(aDivisor) {
        return Math.floor((this.currentTime - this.targetTime) / aDivisor);
    }

};


export function getPluralForm(number, forms) {
    let knownForms = browser.i18n.getMessage('pluralRule').split(';');
    let rules = new Intl.PluralRules();
    let form = rules.select(number);
    return forms.split(';')[knownForms.indexOf(form)];
}


export async function openBackgroundTab(url) {
    let tab = await browser.tabs.getCurrent();
    try {
        await browser.tabs.create({active: false, url: url, openerTabId: tab.id});
    }
    catch(e) {
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
    observers: new Set(),

    initMaster() {
        this.master = true;
        browser.runtime.onMessage.addListener(message => this._notify(message));
    },

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
        }
    },

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

    _send(message) {
        if(this.master) {
            return this._notify(message);
        } else {
            return browser.runtime.sendMessage(message);
        }
    },

    registerObservers(handlers) {
        let listener = message => {
            let {id, _type} = message;
            if(_type !== 'broadcast' && (_type !== 'master' || !this.master)) {
                return;
            }
            let handler = handlers[id];
            if(handler) {
                return handler(message);
            }
        };
        if(Comm.master) {
            Comm.observers.add(listener);
        } else {
            browser.runtime.onMessage.addListener(listener);
        }
        return listener;
    },

    dropObservers(listener) {
        if(Comm.master) {
            Comm.observers.delete(listener);
        } else {
            browser.runtime.onMessage.removeListener(listener);
        }
    },

    broadcast(id, payload) {
        return Comm._send(Object.assign({}, payload, {id, _type: 'broadcast-tx'}));
    },

    callMaster(id, payload) {
        return Comm._send(Object.assign({}, payload, {id, _type: 'master'}));
    },
};
