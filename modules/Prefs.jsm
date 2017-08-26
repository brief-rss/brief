'use strict';

const EXPORTED_SYMBOLS = ['LocalPrefs'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');

const Cc = Components.classes;
const Ci = Components.interfaces;

const PREFIX = 'extensions.brief.'; // We'll register just one observer for this branch

// The prefs manager responsible for default prefs and sync down with WE
const LocalPrefs = {
    // Default values configured with `pref` below
    _defaults: new Map(),
    // Current values (from observers)
    cache: new DataSource(new Map()),
    // Registered upstream pref observers
    _upstream: new Set(),

    init: function() {
        let prefs = Services.prefs.getDefaultBranch("");
        for(let [name, value] of this._defaults) {
            this._set({name, value, branch: prefs});
            if(!name.startsWith(PREFIX)) {
                this._registerUpdater(name);
            }
        }
        this._registerUpdater(PREFIX);
    },

    finalize: function() {
        let prefs = Services.prefs.getDefaultBranch("");
        for(let [name, value] of this._defaults) {
            if(value === undefined)
                continue;
            if(!prefs.prefHasUserValue(name))
                prefs.deleteBranch(name);
        }
        for(let {branch, handler} of this._upstream) {
            branch.removeObserver('', handler);
        }
    },

    get: function(name) {
        return this.cache[name];
    },

    set: function(name, value) {
        this._set({name, value});
    },

    // Read the current pref value
    _get: function(name) {
        let type = Services.prefs.getPrefType(name);
        switch(type) {
            case Services.prefs.PREF_INT:
                return Services.prefs.getIntPref(name);
            case Services.prefs.PREF_BOOL:
                return Services.prefs.getBoolPref(name);
            case Services.prefs.PREF_STRING:
                return Services.prefs.getCharPref(name);
        }
    },

    _set: function({name, value, branch}) {
        let prefs = Services.prefs;
        if(branch !== undefined)
            prefs = branch;
        switch (typeof value) {
            case "boolean":
                prefs.setBoolPref(name, value);
                break;
            case "number":
                prefs.setIntPref(name, value);
                break;
            case "string":
                var str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
                str.data = value;
                prefs.setComplexValue(name, Ci.nsISupportsString, str);
                break;
        }
        this._update(name);
    },

    // Update pref value in our cache
    _update: function(name) {
        let prefs = this.cache.get();
        prefs.set(name, this._get(name))
        this.cache.set(prefs);
    },

    // Register an upstream observer
    _registerUpdater: function(prefix) {
        let handler = (branch, _, name) => this._update(prefix + name);
        let branch = Services.prefs.getBranch(prefix);
        branch.addObserver('', handler);
        this._upstream.add({branch, handler})
    },
}

function pref(name, value) {
    LocalPrefs._defaults.set(name, value);
}

// The actual prefs
pref("extensions.brief.homeFolder", -1);
pref("extensions.brief.showUnreadCounter", true);
pref("extensions.brief.firstRun", true);
pref("extensions.brief.lastVersion", "0");
pref("extensions.brief@mozdev.org.description", "chrome://brief/locale/brief.properties");
pref("extensions.brief.assumeStandardKeys", true);
pref("extensions.brief.showFavicons", true);
pref("extensions.brief.pagePersist", ""); // Temporary storage for ex-XUL-persist attributes

// Deprecated, moved to persistence
pref("extensions.brief.feedview.mode", 0);
pref("extensions.brief.feedview.filterUnread", false);
pref("extensions.brief.feedview.filterStarred", false);

pref("extensions.brief.feedview.doubleClickMarks", true);
pref("extensions.brief.feedview.autoMarkRead", false);
pref("extensions.brief.feedview.sortUnreadViewOldestFirst", false);

pref("extensions.brief.update.interval", 3600);
pref("extensions.brief.update.lastUpdateTime", 0);
pref("extensions.brief.update.enableAutoUpdate", true);
pref("extensions.brief.update.showNotification", true);
pref("extensions.brief.update.defaultFetchDelay", 2000);
pref("extensions.brief.update.backgroundFetchDelay", 4000);
pref("extensions.brief.update.startupDelay", 35000);
pref("extensions.brief.update.suppressSecurityDialogs", true);

pref("extensions.brief.database.expireEntries", false);
pref("extensions.brief.database.entryExpirationAge", 60);
pref("extensions.brief.database.limitStoredEntries", false);
pref("extensions.brief.database.maxStoredEntries", 100);
pref("extensions.brief.database.lastPurgeTime", 0);
pref("extensions.brief.database.keepStarredWhenClearing", true);

// This one will not be modified, only watched
pref("general.smoothScroll", undefined);
