import {Comm} from "/modules/utils.js";

// Preferences are simple string-keyed values.
//
// Note that they are compared for equality and that `undefined` is not a valid value.
// Pref modification checks the name against a whitelist of known prefs.
export let Prefs = {
    // Current pref values
    _values: null,
    // Set of our observers
    _observers: new Set(),

    async init() {
        if(this.ready()) {
            return;
        }
        browser.storage.onChanged.addListener((changes, area) => {
            let pref_changes = changes.prefs;
            if(area !== 'local' || pref_changes === undefined)
                return;
            this._merge(pref_changes.newValue);
        });
        Comm.registerObservers({
            'set-pref': ({name, value, actionName}) => this.set(name, value, actionName),
        });

        let {prefs} = await browser.storage.local.get({prefs: {}});
        this._values = prefs;
    },

    ready: function() {
        return this._values !== null;
    },

    /**
     * @template {keyof KNOWN_PREFS} K
     * @param {K} name
     * @returns {KNOWN_PREFS[K]}
     */
    get: function(name) {
        if(!this.ready()) {
            throw new Error(`pref "${name} accessed before Prefs initialization"`);
        }
        let value = this._values[name];
        if(value === undefined) {
            value = KNOWN_PREFS[name];
        }
        return value;
    },

    /**
     * @template {keyof KNOWN_PREFS} K
     * @param {K} name
     * @param {KNOWN_PREFS[K]} value
     * @param {'update' | 'reset'} actionName
     */
    set: async function(name, value, actionName='update') {
        if(!Comm.master) {
            //@ts-expect-error TS is not smart enough to propagate the relation between types
            // from function args to this call
            return Comm.callMaster('set-pref', {name, value, actionName});
        }
        if(KNOWN_PREFS[name] === undefined) {
            throw new Error(`Brief: pref ${name} does not exist`);
        }
        console.log(`Brief: ${actionName} pref ${name} to ${value}`);
        this._values[name] = value;
        console.log(this._observers);
        this._notifyObservers({name, value});
        await browser.storage.local.set({prefs: this._values});
    },

    /** @param {keyof KNOWN_PREFS} name */
    reset: async function(name) {
        await this.set(name, undefined, 'reset');
    },

    /** @param {string} name */
    addObserver: function(name, observer) {
        this._observers.add({name, observer});
    },

    /** @param {Partial<KNOWN_PREFS>} prefs */
    _merge: function(prefs) {
        for(let [ks, v] of Object.entries(prefs)) {
            let k = /** @type {keyof KNOWN_PREFS} */(ks);
            let oldValue = this.get(k);
            if(v === undefined) {
                v = KNOWN_PREFS[k];
            }
            if(oldValue === v) {
                continue;
            }
            this._values[k] = v;

            this._notifyObservers({name: k, value: v});
        }
    },

    _notifyObservers({name, value}) {
        for(let {name: scope, observer} of this._observers) {
            if(name.startsWith(scope))
                observer({name, value});
        }
    },
};

/**
 * @template {keyof KNOWN_PREFS} K
 * @typedef {{ [P in K]: { name: P, value: KNOWN_PREFS[P] } }[K] } PrefNameValue
 */
/** @typedef {PrefNameValue<keyof KNOWN_PREFS>} PrefNamesValues */


// The default pref values
const KNOWN_PREFS = {
    "homeFolder": -1,
    "showUnreadCounter": true,
    "firstRun": true,
    "lastVersion": "0",
    "assumeStandardKeys": true,
    "showFavicons": true,
    "pagePersist": "", // Temporary storage for ex-XUL-persist attributes

    "feedview.doubleClickMarks": true,
    "feedview.autoMarkRead": false,
    "feedview.sortUnreadViewOldestFirst": false,

    "update.interval": 3600,
    "update.lastUpdateTime": 0,
    "update.enableAutoUpdate": true,
    "update.showNotification": true,
    "update.defaultFetchDelay": 500,
    "update.backgroundFetchDelay": 1000,
    "update.startupDelay": 35000,
    "update.suppressSecurityDialogs": true,
    "update.allowCachedResponses": false, // Testing only (avoid load on upstream servers)

    "database.expireEntries": false,
    "database.entryExpirationAge": 60,
    "database.limitStoredEntries": false,
    "database.maxStoredEntries": 100,
    "database.lastPurgeTime": 0,
    "database.keepStarredWhenClearing": true,

    "monitor.sniffer": false,
    "monitor.sniffer.disconnect": true,

    // UI-controlled prefs (ex Persistence ex XUL persist)
    "ui.startView": "today-folder",
    "ui.closedFolders": "_",
    "ui.tagList.width": "200px",
    "ui.sidebar.width": "400px",
    "ui.sidebar.hidden": false,
    "ui.view.mode": "full",
    "ui.view.filter": "all",

    // Technical pref for migration off defaults
    "_pref.split-defaults": false,
};
