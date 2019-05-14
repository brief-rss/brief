// Preferences are simple string-keyed values.
//
// Note that they are compared for equality and that `undefined` is not a valid value.
// Pref modification checks the name against a whitelist of known prefs.
export let Prefs = {
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

        let {prefs} = await browser.storage.local.get({prefs: {}});
        this._values = prefs;
        await this._migrateOffDefaults();
    },

    get: function(name) {
        let value = this._values[name];
        if(value === undefined) {
            value = this._defaults[name];
        }
        return value;
    },

    set: async function(name, value, actionName='update') {
        if(this._defaults[name] === undefined) {
            throw new Error(`Brief: pref ${name} does not exist`);
        }
        console.log(`Brief: ${actionName} pref ${name} to ${value}`);
        let prefs = Object.assign({}, this._values);
        prefs[name] = value;
        await browser.storage.local.set({prefs});
    },

    reset: async function(name) {
        await this.set(name, undefined, 'reset');
    },

    addObserver: function(name, observer) {
        this._observers.add({name, observer});
    },

    removeObserver: function(name, observer) {
        this._observers.delete({name, observer});
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

            // Notify observers
            for(let {name, observer} of this._observers) {
                if(k.startsWith(name))
                    observer({name: k, value: v});
            }
        }
    },

    // Brief 2.5.* used to have all defaults copied to _values, so all values looked user-set
    _migrateOffDefaults: async function() {
        if(this.get("_pref.split-defaults") === true) {
            return;
        }
        for(let [k, v] of Object.entries(this._values)) {
            if(v === this._defaults[k]) {
                delete this._values[k];
            }
        }
        await this.set("_pref.split-defaults", true);
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

// Technical pref for migration off defaults
pref("_pref.split-defaults", false);
