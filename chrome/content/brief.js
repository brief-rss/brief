Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Storage.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/NetUtil.jsm');

IMPORT_COMMON(this);


var gTemplateURI = NetUtil.newURI('resource://brief-content/feedview-template.html');
var gStringBundle;


function init() {
    PrefObserver.register();

    getElement('headlines-checkbox').checked = PrefCache.showHeadlinesOnly;
    getElement('filter-unread-checkbox').checked = PrefCache.filterUnread;
    getElement('filter-starred-checkbox').checked = PrefCache.filterStarred;
    getElement('reveal-sidebar-button').hidden = !getElement('sidebar').hidden;

    refreshProgressmeter();

    gStringBundle = getElement('main-bundle');

    document.addEventListener('keypress', onKeyPress, true);

    // This listener has to use capturing, because it handles persisting of open/collapsed
    // folder state. If the tree is scrolled as a result of collapsing a folder, we can
    // no longer find the target of the click event, because event.clientY points to
    // where it used to be before scrolling occurred. Therefore, we have to catch the
    // click event before the folder is actually collapsed.
    FeedList.tree.addEventListener('click', FeedList.onClick, true);

    Services.obs.addObserver(FeedList, 'brief:feed-update-queued', false);
    Services.obs.addObserver(FeedList, 'brief:feed-update-finished', false);
    Services.obs.addObserver(FeedList, 'brief:feed-updated', false);
    Services.obs.addObserver(FeedList, 'brief:feed-loading', false);
    Services.obs.addObserver(FeedList, 'brief:feed-error', false);
    Services.obs.addObserver(FeedList, 'brief:invalidate-feedlist', false);
    Services.obs.addObserver(FeedList, 'brief:feed-title-changed', false);
    Services.obs.addObserver(FeedList, 'brief:custom-style-changed', false);

    Storage.addObserver(FeedList);

    ViewList.init();

    // Load feed view.
    let startView = getElement('view-list').getAttribute('startview');
    let name = getElement(startView).getAttribute('name');

    let query = new Query({
        deleted: Storage.ENTRY_STATE_NORMAL,
        read: startView == 'unread-folder' ? false : undefined
    })

    gCurrentView = new FeedView(name, query);

    ViewList.richlistbox.suppressOnSelect = true;
    ViewList.selectedItem = getElement(startView);
    ViewList.richlistbox.suppressOnSelect = false;

    async(FeedList.rebuild, 0, FeedList);
    async(Storage.syncWithLivemarks, 2000, Storage);
}


function unload() {
    var viewList = getElement('view-list');
    var id = viewList.selectedItem && viewList.selectedItem.id;
    var startView = (id == 'unread-folder') ? 'unread-folder' : 'all-items-folder';
    viewList.setAttribute('startview', startView);

    Services.obs.removeObserver(FeedList, 'brief:feed-updated');
    Services.obs.removeObserver(FeedList, 'brief:feed-loading');
    Services.obs.removeObserver(FeedList, 'brief:feed-error');
    Services.obs.removeObserver(FeedList, 'brief:feed-update-queued');
    Services.obs.removeObserver(FeedList, 'brief:feed-update-finished');
    Services.obs.removeObserver(FeedList, 'brief:invalidate-feedlist');
    Services.obs.removeObserver(FeedList, 'brief:feed-title-changed');
    Services.obs.removeObserver(FeedList, 'brief:custom-style-changed');

    PrefObserver.unregister();
    Storage.removeObserver(FeedList);
    gCurrentView.uninit();
}


var Commands = {

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
        var instantApply = Services.prefs.getBoolPref('browser.preferences.instantApply');
        var features = 'chrome,titlebar,toolbar,centerscreen,resizable,';
        features += instantApply ? 'modal=no,dialog=no' : 'modal';

        window.openDialog('chrome://brief/content/options/options.xul', 'Brief options',
                          features, aPaneID);
    },

    markViewRead: function cmd_markViewRead() {
        gCurrentView.query.markEntriesRead(true);
    },

    markVisibleEntriesRead: function cmd_markVisibleEntriesRead() {
        gCurrentView.markVisibleEntriesRead();
    },

    toggleHeadlinesView: function cmd_toggleHeadlinesView() {
        var newState = !PrefCache.showHeadlinesOnly;
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

    skipDown: function cmd_skipDown() {
        gCurrentView.skipDown();
    },

    skipUp: function cmd_skipUp() {
        gCurrentView.skipUp();
    },

    focusSearchbar: function cmd_focusSearchbar() {
        getElement('searchbar').focus();
    },

    toggleEntrySelection: function toggleEntrySelection() {
        var oldValue = PrefCache.entrySelectionEnabled;
        Prefs.setBoolPref('feedview.entrySelectionEnabled', !oldValue);
    },

    toggleSelectedEntryRead: function cmd_toggleSelectedEntryRead() {
        if (gCurrentView.selectedEntry) {
            var newState = !gCurrentView.selectedElement.hasAttribute('read');
            Commands.markEntryRead(gCurrentView.selectedEntry, newState);
        }
    },

    markEntryRead: function cmd_markEntryRead(aEntry, aNewState) {
        new Query(aEntry).markEntriesRead(aNewState);

        if (PrefCache.autoMarkRead && !aNewState)
            gCurrentView.entriesMarkedUnread.push(aEntry);
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
        if (gCurrentView.selectedEntry) {
            var newState = !gCurrentView.selectedElement.hasAttribute('starred');
            Commands.starEntry(gCurrentView.selectedEntry, newState);
        }
    },

    starEntry: function cmd_starEntry(aEntry, aNewState) {
        new Query(aEntry).bookmarkEntries(aNewState);
    },

    toggleSelectedEntryCollapsed: function cmd_toggleSelectedEntryCollapsed() {
        if (gCurrentView.selectedEntry && PrefCache.showHeadlinesOnly) {
            if (gCurrentView.selectedElement.hasAttribute('collapsed'))
                gCurrentView.uncollapseEntry(gCurrentView.selectedEntry, true);
            else
                gCurrentView.collapseEntry(gCurrentView.selectedEntry, true);
        }
    },


    openSelectedEntryLink: function cmd_openSelectedEntryLink() {
        if (gCurrentView.selectedEntry) {
            let newTab = Prefs.getBoolPref('feedview.openEntriesInTabs');
            Commands.openEntryLink(gCurrentView.selectedElement, newTab);
        }
    },

    openEntryLink: function cmd_openEntryLink(aEntryElement, aNewTab) {
        var url = aEntryElement.getAttribute('entryURL');
        Commands.openLink(url, aNewTab);

        if (!aEntryElement.hasAttribute('read')) {
            let entryID = parseInt(aEntryElement.id);
            new Query(entryID).markEntriesRead(true);
        }
    },

    openLink: function cmd_openLink(aURL, aNewTab) {
        var docURI = NetUtil.newURI(document.documentURI);

        if (aNewTab)
            getTopWindow().gBrowser.loadOneTab(aURL, docURI);
        else
            gCurrentView.browser.loadURI(aURL);
    },

    displayShortcuts: function cmd_displayShortcuts() {
        var height = Math.min(window.screen.availHeight, 610);
        var features = 'chrome,centerscreen,titlebar,resizable,width=500,height=' + height;
        var url = 'chrome://brief/content/keyboard-shortcuts.xhtml';

        window.openDialog(url, 'Brief shortcuts', features);
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

        if (aReason == 'canceled') {
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
    var searchbar = getElement('searchbar');
    if (searchbar.value) {
        gCurrentView.titleOverride = gStringBundle.getFormattedString('searchResults',
                                                                      [searchbar.value]);
    }
    else {
        gCurrentView.titleOverride = '';
    }

    gCurrentView.query.searchString = searchbar.value;
    gCurrentView.refresh();
}

function onSearchbarBlur() {
    var searchbar = getElement('searchbar');
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
            if (PrefCache.entrySelectionEnabled)
                gCurrentView.selectPrevEntry();
            else
                gCurrentView.scrollToPrevEntry(true);
        }
        else {
            if (PrefCache.entrySelectionEnabled)
                gCurrentView.selectNextEntry();
            else
                gCurrentView.scrollToNextEntry(true);
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


var Prefs = Services.prefs.getBranch('extensions.brief.')
                          .QueryInterface(Ci.nsIPrefBranch2);

var PrefCache = {};

// Preferences cache and observer.
var PrefObserver = {

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
        entrySelectionEnabled:     'feedview.entrySelectionEnabled',
        autoMarkRead:              'feedview.autoMarkRead',
        filterUnread:              'feedview.filterUnread',
        filterStarred:             'feedview.filterStarred',
        sortUnreadViewOldestFirst: 'feedview.sortUnreadViewOldestFirst',
        showFavicons:              'showFavicons',
        homeFolder:                'homeFolder'
    },

    _updateCachedPref: function PrefObserver__updateCachedPref(aKey) {
        var prefName = this._cachedPrefs[aKey];

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

        for (key in this._cachedPrefs) {
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

            case 'feedview.entrySelectionEnabled':
                if (PrefCache.entrySelectionEnabled)
                    gCurrentView.selectEntry(gCurrentView._getMiddleEntryElement());
                else
                    gCurrentView.selectEntry(null);
                break;

            case 'feedview.showHeadlinesOnly':
                gCurrentView.toggleHeadlinesView();
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
