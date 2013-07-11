Components.utils.import('resource://digest/common.jsm');
Components.utils.import('resource://digest/Storage.jsm');
Components.utils.import('resource://digest/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/NetUtil.jsm');

IMPORT_COMMON(this);


let gCurrentView;


function init() {
    PrefObserver.register();

    getElement('headlines-checkbox').checked = PrefCache.showHeadlinesOnly;
    getElement('filter-unread-checkbox').checked = PrefCache.filterUnread;
    getElement('filter-starred-checkbox').checked = PrefCache.filterStarred;
    getElement('reveal-sidebar-button').hidden = !getElement('sidebar').hidden;

    refreshProgressmeter();

    document.addEventListener('keypress', onKeyPress, true);

    Services.obs.addObserver(FeedList, 'brief:feed-update-queued', false);
    Services.obs.addObserver(FeedList, 'brief:feed-update-finished', false);
    Services.obs.addObserver(FeedList, 'brief:feed-updated', false);
    Services.obs.addObserver(FeedList, 'brief:feed-loading', false);
    Services.obs.addObserver(FeedList, 'brief:feed-error', false);
    Services.obs.addObserver(FeedList, 'brief:invalidate-feedlist', false);
    Services.obs.addObserver(FeedList, 'brief:feed-title-changed', false);
    Services.obs.addObserver(FeedList, 'brief:custom-style-changed', false);
    Services.obs.addObserver(FeedList, 'brief:omit-in-unread-changed', false);

    Storage.addObserver(FeedList);

    ViewList.init();

    let startView = getElement('view-list').getAttribute('startview');
    ViewList.selectedItem = getElement(startView);

    async(FeedList.rebuild, 0, FeedList);
    async(Storage.syncWithLivemarks, 1000, Storage);
}


function unload() {
    let viewList = getElement('view-list');
    let id = viewList.selectedItem && viewList.selectedItem.id;
    let startView = (id == 'unread-folder') ? 'unread-folder' : 'all-items-folder';
    viewList.setAttribute('startview', startView);

    FeedList.persistFolderState();

    Services.obs.removeObserver(FeedList, 'brief:feed-updated');
    Services.obs.removeObserver(FeedList, 'brief:feed-loading');
    Services.obs.removeObserver(FeedList, 'brief:feed-error');
    Services.obs.removeObserver(FeedList, 'brief:feed-update-queued');
    Services.obs.removeObserver(FeedList, 'brief:feed-update-finished');
    Services.obs.removeObserver(FeedList, 'brief:invalidate-feedlist');
    Services.obs.removeObserver(FeedList, 'brief:feed-title-changed');
    Services.obs.removeObserver(FeedList, 'brief:custom-style-changed');
    Services.obs.removeObserver(FeedList, 'brief:omit-in-unread-changed');

    PrefObserver.unregister();
    Storage.removeObserver(FeedList);
    gCurrentView.uninit();
}


let Commands = {

    hideSidebar: function cmd_hideSidebar() {
        getElement('sidebar').hidden = true;
        getElement('sidebar-splitter').hidden = true;
        getElement('tag-list').hidden = true;
        getElement('tag-list-splitter').hidden = true;

        getElement('reveal-sidebar-button').hidden = false;
    },

    revealSidebar: function cmd_revealSidebar() {
        getElement('sidebar').hidden = false;
        getElement('sidebar-splitter').hidden = false;

        if (ViewList.selectedItem == getElement('starred-folder') || TagList.selectedItem) {
            getElement('tag-list').hidden = false;
            getElement('tag-list-splitter').hidden = false;
        }

        getElement('reveal-sidebar-button').hidden = true;

        if (!FeedList.treeReady)
            FeedList.rebuild();
    },

    updateAllFeeds: function cmd_updateAllFeeds() {
        FeedUpdateService.updateAllFeeds();
    },

    stopUpdating: function cmd_stopUpdating() {
        FeedUpdateService.stopUpdating();
    },

    openOptions: function cmd_openOptions(aPaneID) {
        let url = 'chrome://digest/content/options/options.xul';

        let windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            let win = windows.getNext();
            if (win.document.documentURI == url) {
                win.focus();
                return;
            }
        }

        let instantApply = Services.prefs.getBoolPref('browser.preferences.instantApply');
        let features = 'chrome,titlebar,toolbar,centerscreen,resizable,';
        features += instantApply ? 'modal=no,dialog=no' : 'modal';

        window.openDialog(url, 'Digest options', features, aPaneID);
    },

    markViewRead: function cmd_markViewRead() {
        gCurrentView.query.markEntriesRead(true);
    },

    markVisibleEntriesRead: function cmd_markVisibleEntriesRead() {
        gCurrentView.markVisibleEntriesRead();
    },

    toggleHeadlinesView: function cmd_toggleHeadlinesView() {
        let newState = !PrefCache.showHeadlinesOnly;
        Prefs.setBoolPref('feedview.showHeadlinesOnly', newState);
        getElement('headlines-checkbox').checked = newState;
    },

    showAllEntries: function cmd_showAllEntries() {
        Prefs.setBoolPref('feedview.filterUnread', false);
        getElement('filter-unread-checkbox').checked = false;

        Prefs.setBoolPref('feedview.filterStarred', false);
        getElement('filter-starred-checkbox').checked = false;

        gCurrentView.refresh();
    },

    showUnreadEntries: function cmd_showUnreadEntries() {
        if (!PrefCache.filterUnread)
            Commands.toggleUnreadEntriesFilter();
    },

    toggleUnreadEntriesFilter: function cmd_toggleUnreadEntriesFilter() {
        Prefs.setBoolPref('feedview.filterUnread', !PrefCache.filterUnread);
        getElement('filter-unread-checkbox').checked = PrefCache.filterUnread;
        gCurrentView.refresh();
    },

    showStarredEntries: function cmd_showStarredEntries() {
        if (!PrefCache.filterStarred)
            Commands.toggleStarredEntriesFilter();
    },

    toggleStarredEntriesFilter: function cmd_toggleStarredEntriesFilter() {
        Prefs.setBoolPref('feedview.filterStarred', !PrefCache.filterStarred);
        getElement('filter-starred-checkbox').checked = PrefCache.filterStarred;
        gCurrentView.refresh();
    },

    selectNextEntry: function cmd_selectNextEntry() {
        gCurrentView.selectNextEntry();
    },

    selectPrevEntry: function cmd_selectPrevEntry() {
        gCurrentView.selectPrevEntry();
    },

    scrollDownByScreen: function cmd_scrollDownByScreen() {
        gCurrentView.scrollDownByScreen();
    },

    scrollUpByScreen: function cmd_scrollUpByScreen() {
        gCurrentView.scrollUpByScreen();
    },

    focusSearchbar: function cmd_focusSearchbar() {
        getElement('searchbar').focus();
    },

    toggleSelectedEntryRead: function cmd_toggleSelectedEntryRead() {
        let entry = gCurrentView.selectedEntry;
        if (entry) {
            let newState = !gCurrentView.getEntryView(entry).read;
            Commands.markEntryRead(entry, newState);
        }
    },

    markEntryRead: function cmd_markEntryRead(aEntry, aNewState) {
        new Query(aEntry).markEntriesRead(aNewState);
    },

    deleteOrRestoreSelectedEntry: function cmd_deleteOrRestoreSelectedEntry() {
        if (gCurrentView.selectedEntry) {
            if (gCurrentView.query.deleted == Storage.ENTRY_STATE_TRASHED)
                Commands.restoreEntry(gCurrentView.selectedEntry);
            else
                Commands.deleteEntry(gCurrentView.selectedEntry);
        }
    },

    deleteEntry: function cmd_deleteEntry(aEntry) {
        new Query(aEntry).deleteEntries(Storage.ENTRY_STATE_TRASHED);
    },

    restoreEntry: function cmd_restoreEntry(aEntry) {
        new Query(aEntry).deleteEntries(Storage.ENTRY_STATE_NORMAL);
    },

    toggleSelectedEntryStarred: function cmd_toggleSelectedEntryStarred() {
        let entry = gCurrentView.selectedEntry;
        if (entry) {
            let newState = !gCurrentView.getEntryView(entry).starred;
            Commands.starEntry(entry, newState);
        }
    },

    starEntry: function cmd_starEntry(aEntry, aNewState) {
        new Query(aEntry).bookmarkEntries(aNewState);
    },

    toggleSelectedEntryCollapsed: function cmd_toggleSelectedEntryCollapsed() {
        if (!PrefCache.showHeadlinesOnly || !gCurrentView.selectedEntry)
            return;

        let entryView = gCurrentView.getEntryView(gCurrentView.selectedEntry);
        if (entryView.collapsed)
            entryView.expand(true);
        else
            entryView.collapse(true);
    },


    openSelectedEntryLink: function cmd_openSelectedEntryLink() {
        if (!gCurrentView.selectedEntry)
            return;

        Commands.openEntryLink(gCurrentView.selectedEntry);
    },

    openEntryLink: function cmd_openEntryLink(aEntry) {
        let entryView = gCurrentView.getEntryView(aEntry);
        Commands.openLink(entryView.entryURL);

        if (!entryView.read)
            new Query(aEntry).markEntriesRead(true);
    },

    openLink: function cmd_openLink(aURL) {
        let docURI = NetUtil.newURI(document.documentURI);
        getTopWindow().gBrowser.loadOneTab(aURL, docURI);
    },

    displayShortcuts: function cmd_displayShortcuts() {
        let url = 'chrome://digest/content/keyboard-shortcuts.xhtml';

        let windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            let win = windows.getNext();
            if (win.document.documentURI == url) {
                win.focus();
                return;
            }
        }

        let height = Math.min(window.screen.availHeight, 620);
        let features = 'chrome,centerscreen,titlebar,resizable,width=500,height=' + height;

        window.openDialog(url, 'Digest shortcuts', features);
    }
}


function refreshProgressmeter(aReason) {
    if (FeedUpdateService.status != FeedUpdateService.NOT_UPDATING) {
        getElement('update-buttons-deck').selectedIndex = 1;

        if (FeedUpdateService.scheduledFeedsCount > 1)
            getElement('update-progress-deck').selectedIndex = 1;

        getElement('update-progress').value = 100 * FeedUpdateService.completedFeedsCount /
                                                    FeedUpdateService.scheduledFeedsCount;
    }
    else {
        getElement('update-buttons-deck').selectedIndex = 0;

        if (aReason == 'cancelled') {
            getElement('update-progress-deck').selectedIndex = 0;
        }
        else {
            async(function() {
                getElement('update-progress-deck').selectedIndex = 0;
            }, 1000);
        }
    }
}


function onSearchbarCommand() {
    let searchbar = getElement('searchbar');
    let bundle = getElement('main-bundle');

    if (searchbar.value)
        gCurrentView.titleOverride = bundle.getFormattedString('searchResults', [searchbar.value]);
    else
        gCurrentView.titleOverride = '';

    gCurrentView.query.searchString = searchbar.value;
    gCurrentView.refresh();
}

function onSearchbarBlur() {
    let searchbar = getElement('searchbar');
    if (!searchbar.value && gCurrentView.query.searchString) {
        gCurrentView.titleOverride = '';
        gCurrentView.query.searchString = searchbar.value;
        gCurrentView.refresh();
    }
}


/**
 * Space can't be captured using the <key/> XUL element so we handle
 * it manually using a listener. Also, unlike other keys it must be default-prevented.
 */
function onKeyPress(aEvent) {
    // Don't do anything if the user is typing in an input field.
    if (aEvent.originalTarget.localName.toUpperCase() == 'INPUT')
        return;

    // Stop propagation of character keys in order to disable Find-As-You-Type.
    if (aEvent.charCode)
        aEvent.stopPropagation();

    if (Prefs.getBoolPref('assumeStandardKeys') && aEvent.charCode == aEvent.DOM_VK_SPACE) {
        if (aEvent.shiftKey) {
            if (gCurrentView.headlinesView)
                gCurrentView.scrollUpByScreen();
            else
                gCurrentView.selectPrevEntry();
        }
        else {
            if (gCurrentView.headlinesView)
                gCurrentView.scrollDownByScreen();
            else
                gCurrentView.selectNextEntry();
        }

        aEvent.preventDefault();
    }
}

function onMarkViewReadClick(aEvent) {
    if (aEvent.ctrlKey)
        Commands.markVisibleEntriesRead();
    else
        Commands.markViewRead();
}

function getTopWindow() {
    return window.QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIWebNavigation)
                 .QueryInterface(Ci.nsIDocShellTreeItem)
                 .rootTreeItem
                 .QueryInterface(Ci.nsIInterfaceRequestor)
                 .getInterface(Ci.nsIDOMWindow);
}


let Prefs = Services.prefs.getBranch('extensions.brief.')
                          .QueryInterface(Ci.nsIPrefBranch);

let PrefCache = {};

// Preferences cache and observer.
let PrefObserver = {

    register: function PrefObserver_register() {
        for (let key in this._cachedPrefs)
            this._updateCachedPref(key);

        Prefs.addObserver('', this, false);
    },

    unregister: function PrefObserver_unregister() {
        Prefs.removeObserver('', this);
    },

    // Hash table of prefs which are cached and available as properties
    // of PrefCache.
    _cachedPrefs: {
        doubleClickMarks:          'feedview.doubleClickMarks',
        showHeadlinesOnly:         'feedview.showHeadlinesOnly',
        autoMarkRead:              'feedview.autoMarkRead',
        filterUnread:              'feedview.filterUnread',
        filterStarred:             'feedview.filterStarred',
        sortUnreadViewOldestFirst: 'feedview.sortUnreadViewOldestFirst',
        showFavicons:              'showFavicons',
        homeFolder:                'homeFolder'
    },

    _updateCachedPref: function PrefObserver__updateCachedPref(aKey) {
        let prefName = this._cachedPrefs[aKey];

        switch (Prefs.getPrefType(prefName)) {
            case Ci.nsIPrefBranch.PREF_STRING:
                PrefCache[aKey] = Prefs.getCharPref(prefName);
                break;
            case Ci.nsIPrefBranch.PREF_INT:
                PrefCache[aKey] = Prefs.getIntPref(prefName);
                break;
            case Ci.nsIPrefBranch.PREF_BOOL:
                PrefCache[aKey] = Prefs.getBoolPref(prefName);
                break;
        }
    },

    observe: function PrefObserver_observe(aSubject, aTopic, aData) {
        if (aTopic != 'nsPref:changed')
            return;

        for (let key in this._cachedPrefs) {
            if (aData == this._cachedPrefs[key])
                this._updateCachedPref(key);
        }

        switch (aData) {
            case 'feedview.autoMarkRead':
                gCurrentView._autoMarkRead();
                break;

            case 'feedview.sortUnreadViewOldestFirst':
                if (gCurrentView.query.read === false)
                    gCurrentView.refresh();
                break;

            case 'feedview.showHeadlinesOnly':
                gCurrentView.refresh();
                break;
        }
    }

}


// ------- Utility functions --------

function getElement(aId) document.getElementById(aId);

/**
 * Executes given function asynchronously. All arguments besides
 * the first one are optional.
 */
function async(aFunction, aDelay, aObject, arg1, arg2) {
    function asc() {
        aFunction.call(aObject || this, arg1, arg2);
    }
    return setTimeout(asc, aDelay || 0);
}
