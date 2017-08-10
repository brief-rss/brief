'use strict';

const EXPORTED_SYMBOLS = ['PrefLoader'];

Components.utils.import('resource://gre/modules/Services.jsm');

const Cc = Components.classes;
const Ci = Components.interfaces;

// The boilerplate required to set and clear default prefs
const PrefLoader = {
    _prefs: new Map(),

    setDefaultPrefs: function() {
        let prefs = Services.prefs.getDefaultBranch("");
        for(let [name, value] of this._prefs) {
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
        }
    },

    clearDefaultPrefs: function() {
        let prefs = Services.prefs.getDefaultBranch("");
        for(let [name, value] of this._prefs) {
            if(!prefs.prefHasUserValue(name))
                prefs.deleteBranch(name);
        }
    },
}

function pref(name, value) {
    PrefLoader._prefs.set(name, value);
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
