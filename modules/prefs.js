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
     * @param {'update' | 'reset'} actionName
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
};

/** @param {string} name */
function pref(name, value) {
    Prefs._defaults[name] = value;
}

// The default pref values
pref("homeFolder", -1);
pref("showUnreadCounter", true);
pref("firstRun", true);
pref("lastVersion", "0");
pref("assumeStandardKeys", true);
pref("showFavicons", true);
pref("pagePersist", ""); // Temporary storage for ex-XUL-persist attributes

pref("feedview.doubleClickMarks", true);
pref("feedview.autoMarkRead", false);
pref("feedview.sortUnreadViewOldestFirst", false);

pref("update.interval", 3600);
pref("update.lastUpdateTime", 0);
pref("update.enableAutoUpdate", true);
pref("update.showNotification", true);
pref("update.defaultFetchDelay", 500);
pref("update.backgroundFetchDelay", 1000);
pref("update.startupDelay", 35000);
pref("update.suppressSecurityDialogs", true);
pref("update.allowCachedResponses", false); // Testing only (avoid load on upstream servers)

pref("database.expireEntries", false);
pref("database.entryExpirationAge", 60);
pref("database.limitStoredEntries", false);
pref("database.maxStoredEntries", 100);
pref("database.lastPurgeTime", 0);
pref("database.keepStarredWhenClearing", true);

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
