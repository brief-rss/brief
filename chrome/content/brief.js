Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Storage.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/NetUtil.jsm');
Components.utils.import("resource://gre/modules/Promise.jsm");
Components.utils.import('resource://gre/modules/Task.jsm');

IMPORT_COMMON(this);

const OBSERVER_TOPICS = [
    'brief:feed-update-queued',
    'brief:feed-update-finished',
    'brief:feed-updated',
    'brief:feed-loading',
    'brief:feed-error',
    'brief:invalidate-feedlist',
    'brief:feed-title-changed',
    'brief:feed-favicon-changed',
    'brief:custom-style-changed',
]

let gCurrentView;


function init() {
    PrefObserver.register();

    getElement('show-all-entries-checkbox').checked = !PrefCache.filterUnread && !PrefCache.filterStarred;
    getElement('filter-unread-checkbox').checked = PrefCache.filterUnread;
    getElement('filter-starred-checkbox').checked = PrefCache.filterStarred;
    getElement('reveal-sidebar-button').hidden = !getElement('sidebar').hidden;

    // Remove the hardcoded flex from .button-box, impossible to do with CSS.
    let optionsButton = getElement('options-dropdown-button');
    document.getAnonymousNodes(optionsButton)[0].removeAttribute('flex');

    refreshProgressmeter();

    document.addEventListener('keypress', onKeyPress, true);

    for (let topic of OBSERVER_TOPICS)
        Services.obs.addObserver(FeedList, topic, false);

    Storage.addObserver(FeedList);

    let chromeRegService = Cc['@mozilla.org/chrome/chrome-registry;1'].getService();
    let selectedLocale = chromeRegService.QueryInterface(Ci.nsIXULChromeRegistry)
                                         .getSelectedLocale('brief');
    let doc = getElement('feed-view').contentDocument;
    doc.documentElement.setAttribute('lang', selectedLocale);

    ViewList.init();

    let startView = getElement('view-list').getAttribute('startview');
    ViewList.selectedItem = getElement(startView);

    wait().then(() => FeedList.rebuild());
    wait(1000).then(() => Storage.syncWithLivemarks());
}


function unload() {
    let viewList = getElement('view-list');
    let id = viewList.selectedItem && viewList.selectedItem.id;
    let startView = (id == 'today-folder') ? 'today-folder' : 'all-items-folder';
    viewList.setAttribute('startview', startView);

    FeedList.persistFolderState();

    for (let topic of OBSERVER_TOPICS)
        Services.obs.removeObserver(FeedList, topic);

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

    openOptions: function cmd_openOptions(aPaneID) {
        let url = 'chrome://brief/content/options/options.xul';

        let windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            let win = windows.getNext();
            if (win.document.documentURI == url) {
                win.focus();
                return;
            }
        }

        let features = 'chrome,titlebar,toolbar,centerscreen,';
        window.openDialog(url, 'Brief options', features, aPaneID);
    },

    markViewRead: function cmd_markViewRead() {
        gCurrentView.query.markEntriesRead(true);
    },

    markVisibleEntriesRead: function cmd_markVisibleEntriesRead() {
        gCurrentView.markVisibleEntriesRead();
    },

    switchViewMode: function cmd_switchViewMode(aMode) {
        if (FeedList.selectedFeed) {
            Storage.changeFeedProperties({
                feedID: FeedList.selectedFeed.feedID,
                viewMode: aMode
            });
        }
        else {
            Prefs.setIntPref('feedview.mode', aMode);
        }

        gCurrentView.refresh();
    },

    switchViewFilter: function cmd_switchViewFilter(aFilter) {
        let filterUnread = aFilter == 'unread';
        let filterStarred = aFilter == 'starred';

        Prefs.setBoolPref('feedview.filterUnread', filterUnread);
        Prefs.setBoolPref('feedview.filterStarred', filterStarred);
    },

    openFeedWebsite: function cmd_openWebsite(aFeed) {
        let url = aFeed.websiteURL || NetUtil.newURI(aFeed.feedURL).host;
        getTopWindow().gBrowser.loadOneTab(url);
    },

    emptyFeed: function cmd_emptyFeed(aFeed) {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            starred: false,
            feeds: [aFeed.feedID]
        })
        query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
    },

    deleteFeed: function cmd_deleteFeed(aFeed) {
        let bundle = getElement('main-bundle');
        let title = bundle.getString('confirmFeedDeletionTitle');
        let text = bundle.getFormattedString('confirmFeedDeletionText', [aFeed.title]);

        if (Services.prompt.confirm(window, title, text)) {
            FeedList.removeItem(getElement(aFeed.feedID));
            FeedList.expectRemovalInvalidate = true;

            Components.utils.import('resource://gre/modules/PlacesUtils.jsm');

            let txn = new PlacesRemoveItemTransaction(aFeed.bookmarkID);
            PlacesUtils.transactionManager.doTransaction(txn);
        }
    },

    restoreTrashed: function cmd_restoreTrashed() {
        ViewList.getQueryForView('trash-folder')
                .deleteEntries(Storage.ENTRY_STATE_NORMAL);
    },

    emptyTrash: function cmd_emptyTrash() {
        ViewList.getQueryForView('trash-folder')
                .deleteEntries(Storage.ENTRY_STATE_DELETED);
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
        if (!gCurrentView.headlinesMode || !gCurrentView.selectedEntry)
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

        let baseURI = NetUtil.newURI(Storage.getFeed(entryView.feedID).feedURL);
        let linkURI = NetUtil.newURI(entryView.entryURL, null, baseURI);

        Commands.openLink(linkURI.spec);

        if (!entryView.read)
            new Query(aEntry).markEntriesRead(true);
    },

    openLink: function cmd_openLink(aURL) {
        let docURI = NetUtil.newURI(document.documentURI);
        getTopWindow().gBrowser.loadOneTab(aURL, docURI);
    },


    showFeedProperties: function cmd_showFeedProperties(aFeed) {
        openDialog('chrome://brief/content/options/feed-properties.xul', 'FeedProperties',
                   'chrome,titlebar,toolbar,centerscreen,modal', aFeed.feedID);
    },

    displayShortcuts: function cmd_displayShortcuts() {
        let url = 'chrome://brief/content/keyboard-shortcuts.xhtml';

        let windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            let win = windows.getNext();
            if (win.document.documentURI == url) {
                win.focus();
                return;
            }
        }

        let height = Math.min(window.screen.availHeight, 650);
        let features = 'chrome,centerscreen,titlebar,resizable,width=500,height=' + height;

        window.openDialog(url, 'Brief shortcuts', features);
    },

    openLibrary: function cmd_openLibrary() {
        let organizer = Services.wm.getMostRecentWindow('Places:Organizer');
        if (!organizer) {
            var appInfo = Components.classes["@mozilla.org/xre/app-info;1"]
                                    .getService(Components.interfaces.nsIXULAppInfo);
	    const FIREFOX_ID = "{ec8030f7-c20a-464f-9b0e-13a3a9e97384}";
            const SEAMONKEY_ID = "{92650c4d-4b8e-4d2a-b7eb-24ecf4f6b63a}";
            if (appInfo.ID == FIREFOX_ID) {
                openDialog('chrome://browser/content/places/places.xul', '',
                           'chrome,toolbar=yes,dialog=no,resizable', PrefCache.homeFolder);
            } else if (appInfo.ID == SEAMONKEY_ID) {
                openDialog('chrome://communicator/content/bookmarks/bookmarksManager.xul', '',
                           'chrome,toolbar=yes,dialog=no,resizable', PrefCache.homeFolder);
            } 
        }
        else {
            organizer.PlacesOrganizer.selectLeftPaneContainerByHierarchy(PrefCache.homeFolder);
            organizer.focus();
        }
    },

}

function showContextOptionsDropdown() {
    if (ViewList.selectedItem && ViewList.selectedItem.id == 'trash-folder')
        var panelID = 'brief-trash-actions-panel';
    else if (FeedList.selectedFeed && !FeedList.selectedFeed.isFolder)
        panelID = 'brief-feed-settings-panel';
    else
        return;

    let panel = getTopWindow().document.getElementById(panelID);

    // Modify the position to horizontally center the arrow on the anchor.
    let anchor = getElement('view-title-button');
    panel.openPopup(anchor, 'after_start', -11, 0);
}

function showOptionsDropdown() {
    let panel = getTopWindow().document.getElementById('brief-options-panel')

    let button = getElement('options-dropdown-button');
    let rect = button.getBoundingClientRect();

    // Modify the position to horizontally center the arrow on the text.
    // We must account for widths of the panel arrow and the button dropmarker.
    panel.openPopup(button, 'after_start', (rect.width - 10) / 2 - 18, 0);
}

function refreshProgressmeter(aReason) {
    if (FeedUpdateService.status != FeedUpdateService.NOT_UPDATING) {
        getElement('update-buttons-deck').selectedIndex = 1;

        if (FeedUpdateService.scheduledFeedsCount > 1)
            getElement('update-progress').setAttribute('show', true);

        getElement('update-progress').value = 100 * FeedUpdateService.completedFeedsCount /
                                                    FeedUpdateService.scheduledFeedsCount;
    }
    else {
        getElement('update-buttons-deck').selectedIndex = 0;
        getElement('update-progress').removeAttribute('show');
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


let Prefs = Services.prefs.getBranch('extensions.brief.');

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
        viewMode:                  'feedview.mode',
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

            case 'feedview.filterUnread':
            case 'feedview.filterStarred':
                getElement('filter-unread-checkbox').checked = PrefCache.filterUnread;
                getElement('filter-starred-checkbox').checked = PrefCache.filterStarred;
                getElement('show-all-entries-checkbox').checked = !PrefCache.filterUnread &&
                                                                  !PrefCache.filterStarred;
                gCurrentView.refresh();
                break;
        }
    }

}


// ------- Utility functions --------

function getElement(aId) document.getElementById(aId);
