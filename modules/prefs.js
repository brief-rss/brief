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
    // Defaults
    _defaults: {},
    // Defaults as of Brief 2.5.9 (user-ve-default split)
    // When splitting default and user prefs these values are considered default
    _defaultEquivalent: {},

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
        await this._migrateOffDefaults();
    },

    ready: function() {
        return this._values !== null;
    },

    /** @param {string} name */
    get: function(name) {
        if(!this.ready()) {
            throw new Error(`pref "${name} accessed before Prefs initialization"`);
        }
        let value = this._values[name];
        if(value === undefined) {
            value = this._defaults[name];
        }
        return value;
    },

    /**
     * @param {string} name
     * @param {string} actionName
     */
    set: async function(name, value, actionName='update') {
        if(!Comm.master) {
            return Comm.callMaster('set-pref', {name, value, actionName});
        }
        if(this._defaults[name] === undefined) {
            throw new Error(`Brief: pref ${name} does not exist`);
        }
        console.log(`Brief: ${actionName} pref ${name} to ${value}`);
        this._values[name] = value;
        console.log(this._observers);
        this._notifyObservers({name, value});
        await browser.storage.local.set({prefs: this._values});
    },

    /** @param {string} name */
    reset: async function(name) {
        await this.set(name, undefined, 'reset');
    },

    /** @param {string} name */
    addObserver: function(name, observer) {
        this._observers.add({name, observer});
    },

    _merge: function(prefs) {
        for(let [k, v] of Object.entries(prefs)) {
            let oldValue = this.get(k);
            if(v === undefined) {
                v = this._defaults[k];
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

    // Brief 2.5.* used to have all defaults copied to _values, so all values looked user-set
    _migrateOffDefaults: async function() {
        if(this.get("_pref.split-defaults") === true) {
            return;
        }
        for(let [k, v] of Object.entries(this._values)) {
            if(v === this._defaultEquivalent[k]) {
                delete this._values[k];
            }
        }
        await this.set("_pref.split-defaults", true);
    },
};

/** @param {string} name */
function pref(name, value, extra) {
    Prefs._defaults[name] = value;
    if(extra !== undefined) {
        let {defaultEquivalent} = extra;
        if(defaultEquivalent !== undefined) {
            Prefs._defaultEquivalent[name] = defaultEquivalent;
        }
    }
}

// Do not use, upgrade to explicit when the value needs to change
// Exists to avoid duplication of defaults for the pre-split prefs
/** @param {string} name */
function old_pref(name, value) {
    pref(name, value, {defaultEquivalent: value});
}

// The actual old_prefs and new prefs
old_pref("homeFolder", -1);
old_pref("showUnreadCounter", true);
old_pref("firstRun", true);
old_pref("lastVersion", "0");
old_pref("assumeStandardKeys", true);
old_pref("showFavicons", true);
old_pref("pagePersist", ""); // Temporary storage for ex-XUL-persist attributes

old_pref("feedview.doubleClickMarks", true);
old_pref("feedview.autoMarkRead", false);
old_pref("feedview.sortUnreadViewOldestFirst", false);

old_pref("update.interval", 3600);
old_pref("update.lastUpdateTime", 0);
old_pref("update.enableAutoUpdate", true);
old_pref("update.showNotification", true);
pref("update.defaultFetchDelay", 500, {defaultEquivalent: 2000});
pref("update.backgroundFetchDelay", 1000, {defaultEquivalent: 4000});
old_pref("update.startupDelay", 35000);
old_pref("update.suppressSecurityDialogs", true);
old_pref("update.allowCachedResponses", false); // Testing only (avoid load on upstream servers)

old_pref("database.expireEntries", false);
old_pref("database.entryExpirationAge", 60);
old_pref("database.limitStoredEntries", false);
old_pref("database.maxStoredEntries", 100);
old_pref("database.lastPurgeTime", 0);
old_pref("database.keepStarredWhenClearing", true);

pref("monitor.sniffer", false);
pref("monitor.sniffer.disconnect", true);

// UI-controlled prefs (ex Persistence ex XUL persist)
pref("ui.startView", "today-folder");
pref("ui.closedFolders", "_");
pref("ui.tagList.width", "200px");
pref("ui.sidebar.width", "400px");
pref("ui.sidebar.hidden", false);
pref("ui.view.mode", "full");
pref("ui.view.filter", "all");

// Technical pref for migration off defaults
pref("_pref.split-defaults", false);
