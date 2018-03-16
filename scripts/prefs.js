'use strict';

let Prefs = {
    // Message channel
    _port: null,
    // Current pref values
    _values: {},
    // Set of our observers
    _observers: new Set(),
    // Defaults
    _defaults: {},

    init: async function() {
        browser.storage.onChanged.addListener((changes, area) => {
            let pref_changes = changes.prefs;
            if(area !== 'local' || pref_changes === undefined)
                return;
            this._merge(pref_changes.newValue);
        });

        let {prefs} = await browser.storage.local.get({prefs: this._defaults});
        this._values = prefs;
    },

    get: function(name) {
        let value = this._values[name];
        if(value === undefined) {
            value = this._defaults[name];
        }
        return value;
    },

    set: async function(name, value) {
        console.log("Brief: update pref", name, "to", value);
        let prefs = Object.assign({}, this._values);
        prefs[name] = value;
        await browser.storage.local.set({prefs});
    },

    addObserver: function(name, observer) {
        this._observers.add({name, observer});
    },

    removeObserver: function(name, observer) {
        this._observers.delete({name, observer});
    },

    _merge: function(prefs) {
        for(let [k, v] of Object.entries(prefs)) {
            if(this._values[k] !== undefined && this._values[k] === v)
                continue;
            this._values[k] = v;

            // Notify observers
            for(let {name, observer} of this._observers) {
                if(k.startsWith(name))
                    observer({name: k, value: v});
            }
        }
    },
};
// TODO: split defaults from user prefs

function pref(name, value) {
    Prefs._defaults[name] = value;
}

// The actual prefs
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
pref("update.defaultFetchDelay", 2000);
pref("update.backgroundFetchDelay", 4000);
pref("update.startupDelay", 35000);
pref("update.suppressSecurityDialogs", true);
pref("update.allowCachedResponses", false); // Testing only (avoid load on upstream servers)

pref("database.expireEntries", false);
pref("database.entryExpirationAge", 60);
pref("database.limitStoredEntries", false);
pref("database.maxStoredEntries", 100);
pref("database.lastPurgeTime", 0);
pref("database.keepStarredWhenClearing", true);
