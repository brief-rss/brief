'use strict';

let Prefs = {
    // Message channel
    _port: null,
    // Current pref values
    _values: {},
    // Signal that prefs have been received
    _signalReady: null,
    // Set of our observers
    _observers: new Set(),
    // Reverse pref name mapping
    _externNames: new Map(),

    init: async function() {
        let ready = new Promise((resolve, reject) => {
            this._signalReady = resolve;
        });
        this._port = browser.runtime.connect({name: 'watch-prefs'});
        this._port.onMessage.addListener(prefs => this._merge(prefs));

        await ready;
    },

    get: function(name) {
        return this._values[name];
    },

    set: async function(name, value) {
        await browser.runtime.sendMessage(
            {id: 'set-pref', name: this._externNames.get(name), value});
    },

    addObserver: function(name, observer) {
        this._observers.add({name, observer});
    },

    removeObserver: function(name, observer) {
        this._observers.delete({name, observer});
    },

    _merge: function(prefs) {
        for(let [k,v] of prefs) {
            // Slightly rearrange prefs on this migration
            // Remove redundant prefixes
            for(let prefix of [/^extensions.brief\./, /^general\./]) {
                if(!k.match(prefix))
                    continue;
                let name = k.replace(prefix, '');
                this._externNames.set(name, k);
                k = name;
            }
            // Drop this pref we never use anyway
            if(k === 'extensions.brief@mozdev.org.description')
                continue;

            if(this._values[k] === v)
                continue;
            this._values[k] = v;

            // Notify observers
            for(let {name, observer} of this._observers) {
                if(k.startsWith(name))
                    observer({name: k, value: v});
            }
        }
        browser.storage.local.set({prefs: this._values});
        if(this._signalReady !== null)
            this._signalReady();
        this._signalReady = null;
    },
};
