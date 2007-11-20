const EXT_ID = 'brief@mozdev.org';
const TEMPLATE_FILENAME = 'feedview-template.html';
const DEFAULT_STYLE_PATH = 'chrome://brief/skin/feedview.css'
const LAST_MAJOR_VERSION = '1.0';
const RELEASE_NOTES_URL = 'http://brief.mozdev.org/versions/1.0.html';

const Cc = Components.classes;
const Ci = Components.interfaces;

const gStorage = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
const gUpdateService = Cc['@ancestor/brief/updateservice;1'].getService(Ci.nsIBriefUpdateService);
var QuerySH = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery', 'setConditions');
var Query = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery');

const ENTRY_STATE_NORMAL = Ci.nsIBriefQuery.ENTRY_STATE_NORMAL;
const ENTRY_STATE_TRASHED = Ci.nsIBriefQuery.ENTRY_STATE_TRASHED;
const ENTRY_STATE_DELETED = Ci.nsIBriefQuery.ENTRY_STATE_DELETED;
const ENTRY_STATE_ANY = Ci.nsIBriefQuery.ENTRY_STATE_ANY;

var gFeedView = null;
var gInitialized = false;
var gTopBrowserWindow;
var gTemplateURI;
var gFeedViewStyle;

function init() {
    if (gInitialized)
        return;
    gInitialized = true;

    gPrefs.register();
    gFeedViewStyle = getFeedViewStyle();

    // Get the extension's directory.
    var itemLocation = Cc['@mozilla.org/extensions/manager;1'].
                       getService(Ci.nsIExtensionManager).
                       getInstallLocation(EXT_ID).
                       getItemLocation(EXT_ID);
    // Get the template file.
    itemLocation.append('defaults');
    itemLocation.append('data');
    itemLocation.append(TEMPLATE_FILENAME);
    // Create URI of the template file.
    gTemplateURI = Cc['@mozilla.org/network/protocol;1?name=file'].
                   getService(Ci.nsIFileProtocolHandler).
                   newFileURI(itemLocation);

    var liveBookmarksFolder = gPrefs.getCharPref('liveBookmarksFolder');
    if (liveBookmarksFolder) {
        // Initiate the feed list (asynchronously, so that the window is displayed sooner).
        setTimeout(function(){ gFeedList.rebuild() }, 0);
        setTimeout(function(){ gStorage.syncWithBookmarks() }, 500);
    }
    else {
        // If no Live Bookmarks folder has been picked yet, show a panel to select it.
        var deck = document.getElementById('feed-list-deck');
        deck.selectedIndex = 1;
    }

    gTopBrowserWindow = window.QueryInterface(Ci.nsIInterfaceRequestor).
                               getInterface(Ci.nsIWebNavigation).
                               QueryInterface(Ci.nsIDocShellTreeItem).
                               rootTreeItem.
                               QueryInterface(Ci.nsIInterfaceRequestor).
                               getInterface(Ci.nsIDOMWindow);

    var headlinesCheckbox = document.getElementById('headlines-checkbox');
    headlinesCheckbox.checked = gPrefs.showHeadlinesOnly;
    var viewConstraintList = document.getElementById('view-constraint-list');
    viewConstraintList.selectedIndex = gPrefs.shownEntries == 'all' ? 0 :
                                       gPrefs.shownEntries == 'unread' ? 1 : 2;

    document.addEventListener('DoCommand', onDoCommand, false);
    document.addEventListener('keypress', onKeyPress, true);

    var observerService = Cc["@mozilla.org/observer-service;1"].
                          getService(Ci.nsIObserverService);

    observerService.addObserver(gObserver, 'brief:feed-updated', false);
    observerService.addObserver(gObserver, 'brief:feed-loading', false);
    observerService.addObserver(gObserver, 'brief:feed-error', false);
    observerService.addObserver(gObserver, 'brief:entry-status-changed', false);
    observerService.addObserver(gObserver, 'brief:feed-update-queued', false);
    observerService.addObserver(gObserver, 'brief:feed-update-canceled', false);

    observerService.addObserver(gFeedList, 'brief:invalidate-feedlist', false);
    observerService.addObserver(gFeedList, 'brief:feed-title-changed', false);

    // Cache the strings, so they don't have to retrieved every time when
    // refreshing the feed view.
    var bundle = document.getElementById('main-bundle');
    FeedView.prototype.todayStr = bundle.getString('today');
    FeedView.prototype.yesterdayStr = bundle.getString('yesterday');
    FeedView.prototype.authorPrefixStr = bundle.getString('authorIntroductionPrefix') + ' ';
    FeedView.prototype.updatedStr = bundle.getString('entryWasUpdated');
    FeedView.prototype.markAsReadStr = bundle.getString('markEntryAsRead');
    FeedView.prototype.markAsUnreadStr = bundle.getString('markEntryAsUnread');

    setTimeout(function(){ loadHomeview() }, 0);

    // Init stuff in bookmarks.js
    setTimeout(function() { initServices(); initBMService(); }, 1000);
}


function unload() {
    var observerService = Cc["@mozilla.org/observer-service;1"].
                          getService(Ci.nsIObserverService);
    observerService.removeObserver(gObserver, 'brief:feed-updated');
    observerService.removeObserver(gObserver, 'brief:feed-loading');
    observerService.removeObserver(gObserver, 'brief:feed-error');
    observerService.removeObserver(gObserver, 'brief:entry-status-changed');
    observerService.removeObserver(gObserver, 'brief:feed-update-queued');
    observerService.removeObserver(gObserver, 'brief:feed-update-canceled');

    observerService.removeObserver(gFeedList, 'brief:invalidate-feedlist');
    observerService.removeObserver(gFeedList, 'brief:feed-title-changed');

    gPrefs.unregister();
}


// Storage and UpdateService components communicate with us through global notifications.
var gObserver = {

    observe: function gObserver_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

        // A feed update was finished and new entries are available. Restore the
        // favicon instead of the throbber (or error icon), refresh the feed treeitem
        // and the feedview if necessary.
        case 'brief:feed-updated':
            var feedID = aData;
            var item = gFeedList.getTreeitem(feedID);
            item.removeAttribute('error');
            item.removeAttribute('loading');
            gFeedList.refreshFeedTreeitems(item);
            updateProgressMeter();

            if (aSubject.QueryInterface(Ci.nsIVariant) > 0) {
              gFeedList.refreshSpecialTreeitem('unread-folder');
              if (gFeedView)
                gFeedView.ensure();
            }
            break;

        // A feed was requested; show throbber as its icon.
        case 'brief:feed-loading':
            var item = gFeedList.getTreeitem(aData);
            item.setAttribute('loading', true);
            gFeedList.refreshFeedTreeitems(item);
            break;

        // An error occured when downloading or parsing a feed; show error icon.
        case 'brief:feed-error':
            var feedID = aData;
            var item = gFeedList.getTreeitem(feedID);
            item.removeAttribute('loading');
            item.setAttribute('error', true);
            gFeedList.refreshFeedTreeitems(item);
            updateProgressMeter();
            break;

        // Sets up the updating progressmeter.
        case 'brief:feed-update-queued':
            // Don't display progress for background updates.
            if (aData == 'background')
                return;

            var deck = document.getElementById('update-buttons-deck');
            deck.selectedIndex = 1;

            var progressmeter = document.getElementById('update-progress');
            progressmeter.hidden = false;
            progressmeter.value = 100 * gUpdateService.completedFeedsCount /
                                        gUpdateService.totalFeedsCount;
            break;

        case 'brief:feed-update-canceled':
            var progressmeter = document.getElementById('update-progress');
            progressmeter.hidden = true;
            progressmeter.value = 0;

            var items = gFeedList.items;
            for (var i = 0; i < items.length; i++) {
                if (items[i].hasAttribute('loading')) {
                    items[i].removeAttribute('loading');
                    gFeedList.refreshFeedTreeitems(items[i]);
                }
            }
            break;

        // Entries were marked as read/unread, starred, trashed, restored, or deleted.
        case 'brief:entry-status-changed':
            this.onEntryStatusChanged(aSubject, aData);
            break;
        }
    },

    // Updates the approperiate treeitems in the feed list
    // and refreshes the feedview when necessary.
    onEntryStatusChanged: function gObserver_onEntryStatusChanged(aChangedItems, aChangeType) {
        aChangedItems.QueryInterface(Ci.nsIWritablePropertyBag2);
        var changedFeeds = aChangedItems.getPropertyAsAString('feeds').
                                         match(/[^ ]+/g);
        var changedEntries = aChangedItems.getPropertyAsAString('entries').
                                           match(/[^ ]+/g);

        var viewIsCool = true;
        if (gFeedView)
            viewIsCool = gFeedView.ensure();

        switch (aChangeType) {
        case 'unread':
        case 'read':
            // Just visually mark the changed entries as read/unread.
            if (gFeedView && gFeedView.isActive && viewIsCool) {
                var nodes = gFeedView.feedContent.childNodes;
                for (i = 0; i < nodes.length; i++) {
                    if (changedEntries.indexOf(nodes[i].id) != -1) {
                        if (aChangeType == 'read')
                            nodes[i].setAttribute('read', 'true');
                        else
                            nodes[i].removeAttribute('read');
                    }
                }
            }

            // Do everything asychronously to speed up refreshing of the feed view.
            setTimeout(function(){gFeedList.refreshFeedTreeitems(changedFeeds)}, 0);

            // We can't know if any of those need updating, so we have to
            // update them all.
            setTimeout(function(){gFeedList.refreshSpecialTreeitem('unread-folder')}, 0);
            setTimeout(function(){gFeedList.refreshSpecialTreeitem('starred-folder')}, 0);
            setTimeout(function(){gFeedList.refreshSpecialTreeitem('trash-folder')}, 0);
            break;

        case 'starred':
            setTimeout(function(){gFeedList.refreshSpecialTreeitem('starred-folder')}, 0);
            break;

        case 'deleted':
            setTimeout(function(){gFeedList.refreshFeedTreeitems(changedFeeds)}, 0);

            setTimeout(function(){gFeedList.refreshSpecialTreeitem('unread-folder')}, 0);
            setTimeout(function(){gFeedList.refreshSpecialTreeitem('starred-folder')}, 0);
            setTimeout(function(){gFeedList.refreshSpecialTreeitem('trash-folder')}, 0);
        }
    }

}


function onDoCommand(aEvent) {
    var commandName = document.documentElement.getAttribute('command');
    var command = gCommands[commandName];
    command();
}


var gCommands = {

    toggleLeftPane: function cmd_toggleLeftPane(aEvent) {
        var pane = document.getElementById('left-pane');
        var splitter = document.getElementById('left-pane-splitter');
        pane.hidden = splitter.hidden = !pane.hidden;
    },

    updateAllFeeds: function cmd_updateAllFeeds() {
        gUpdateService.fetchAllFeeds(false);
    },

    stopUpdating: function cmd_stopUpdating() {
        gUpdateService.stopFetching();
        var deck = document.getElementById('update-buttons-deck');
        deck.selectedIndex = 0;
    },

    openOptions: function cmd_openOptions(aPaneID) {
        window.openDialog('chrome://brief/content/options/options.xul', 'Brief options',
                          'chrome,titlebar,toolbar,centerscreen,modal,resizable', aPaneID);

    },

    markCurrentViewRead: function cmd_markCurrentViewRead() {
        gFeedView.query.markEntriesRead(true);
    },

    toggleHeadlinesMode: function cmd_toggleHeadlinesMode() {
        var newState = !gPrefs.showHeadlinesOnly;
        gPrefs.setBoolPref('feedview.showHeadlinesOnly', newState);

        var checkbox = document.getElementById('headlines-checkbox');
        checkbox.checked = newState;

        if (!gFeedView)
            return;

        if (newState) {
            gFeedView.feedContent.setAttribute('showHeadlinesOnly', true);
            for (var i = 0; i < gFeedView.feedContent.childNodes.length; i++)
                gFeedView.feedContent.childNodes[i].setAttribute('collapsed', true);
        }
        else {
            gFeedView.feedContent.removeAttribute('showHeadlinesOnly');
            for (var i = 0; i < gFeedView.feedContent.childNodes.length; i++)
                gFeedView.feedContent.childNodes[i].removeAttribute('collapsed');
        }
    },

    showAllEntries: function cmd_showAllEntries() {
        gCommands.switchViewConstraint('all');
    },

    showUnreadEntries: function cmd_showUnreadEntries() {
        gCommands.switchViewConstraint('unread');
    },

    showStarredEntries: function cmd_showStarredEntries() {
        gCommands.switchViewConstraint('starred');
    },

    switchViewConstraint: function cmd_switchViewConstraint(aConstraint) {
        if (gPrefs.shownEntries != aConstraint) {
            gPrefs.setCharPref('feedview.shownEntries', aConstraint);

            if (gFeedView)
                gFeedView.refresh();
        }
    },

    showNextPage: function cmd_showNextPage() {
        if (gFeedView)
            gFeedView.currentPage++;
    },

    showPrevPage: function cmd_showPrevPage() {
        if (gFeedView)
            gFeedView.currentPage--;
    },

    selectNextEntry: function cmd_selectNextEntry() {
        if (gFeedView)
            gFeedView.selectNextEntry()
    },

    selectPrevEntry: function cmd_selectPrevEntry() {
        if (gFeedView)
            gFeedView.selectPrevEntry();
    },

    markSelectedEntryRead: function cmd_markSelectedEntryRead() {
        if (!gFeedView || !gFeedView.selectedEntry)
            return;

        var selectedEntry = gFeedView.selectedEntry;
        var entryID = selectedEntry.getAttribute('id');
        var newStatus = !selectedEntry.hasAttribute('read');

        if (newStatus)
            selectedEntry.setAttribute('read', true);
        else
            selectedEntry.removeAttribute('read');

        var query = new QuerySH(null, entryID, null);
        query.deleted = ENTRY_STATE_ANY;
        query.markEntriesRead(newStatus)
    },


    deleteSelectedEntry: function cmd_deleteSelectedEntry() {
        if (!gFeedView || !gFeedView.selectedEntry)
            return;

        var entryID = gFeedView.selectedEntry.getAttribute('id');
        var query = new QuerySH(null, entryID, null);
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },


    restoreSelectedEntry: function cmd_restoreSelectedEntry() {
        if (!gFeedView || !gFeedView.selectedEntry)
            return;

        var entryID = gFeedView.selectedEntry.getAttribute('id');
        var query = new QuerySH(null, entryID, null);
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_NORMAL);
    },


    starSelectedEntry: function cmd_starSelectedEntry() {
        if (!gFeedView || !gFeedView.selectedEntry)
            return;

        var selectedEntry = gFeedView.selectedEntry;
        var entryID = selectedEntry.getAttribute('id');
        var newStatus = !selectedEntry.hasAttribute('starred');

        if (newStatus)
            selectedEntry.setAttribute('starred', true);
        else
            selectedEntry.removeAttribute('starred');

        var query = new QuerySH(null, entryID, null);
        query.starEntries(newStatus);
    },

    unfoldSelectedEntry: function cmd_unfoldSelectedEntry() {
        if (!gFeedView || !gFeedView.selectedEntry || !gPrefs.showHeadlinesOnly)
            return;

        var evt = document.createEvent('Events');
        evt.initEvent('CollapseEntry', false, false);
        gFeedView.selectedEntry.dispatchEvent(evt);
        setTimeout(function(){ gFeedView.selectedEntry.scrollIntoView(false) }, 310);
    },

    focusSearchbar: function cmd_focusSearchbar() {
        var searchbar = document.getElementById('searchbar');
        searchbar.focus();
    },

    turnOffKeyNav: function cmd_turnOffKeyNav() {
        if (gPrefs.keyNavEnabled) {
            gPrefs.setBoolPref('feedview.keyNavEnabled', false);
            if (gFeedView)
                gFeedView.selectEntry(null);
        }
    },

    openSelectedEntryLinkInTab: function cmd_openSelectedEntryLinkInTab() {
        gCommands.openSelectedEntryLink(true);
    },

    openSelectedEntryLink: function cmd_openSelectedEntryLink(aForceNewTab) {
        if (!gFeedView || !gFeedView.selectedEntry)
            return;

        var newTab = gPrefs.getBoolPref('feedview.openEntriesInTabs') || aForceNewTab;
        gCommands.openEntryLink(gFeedView.selectedEntry, newTab);
    },

    openEntryLink: function cmd_openEntryLink(aEntry, aNewTab) {
        var url = aEntry.getAttribute('entryURL');

        if (aNewTab) {
            var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                             getService(Ci.nsIPrefBranch);
            var whereToOpen = prefBranch.getIntPref('browser.link.open_newwindow');
            if (whereToOpen == 2)
                openDialog('chrome://browser/content/browser.xul', '_blank', 'chrome,all,dialog=no', url);
            else
                gTopBrowserWindow.gBrowser.loadOneTab(url);
        }
        else {
            gFeedView.browser.loadURI(url);
        }

        if (!aEntry.hasAttribute('read')) {
            aEntry.setAttribute('read', true);
            var query = new QuerySH(null, aEntry.id, null);
            query.markEntriesRead(true);
        }
    },

    displayShortcuts: function cmd_displayShortcuts() {
        if (gFeedView && gFeedView.isActive) {
            var evt = document.createEvent('Events');
            evt.initEvent('DisplayShortcuts', false, false);
            gFeedView.document.dispatchEvent(evt);
        }
    }
}

// Returns a string containing the style of the feed view.
function getFeedViewStyle() {
    if (gPrefs.getBoolPref('feedview.useCustomStyle')) {
        var pref = gPrefs.getComplexValue('feedview.customStylePath',
                                          Ci.nsISupportsString);
        var url = 'file:///' + pref.data;
    }
    else {
        var url = DEFAULT_STYLE_PATH;
    }

    var request = new XMLHttpRequest;
    request.open('GET', url, false);
    request.send(null);

    return request.responseText;
}


function loadHomeview() {
    // If Brief has been update, load the new version info page.
    var prevVersion = gPrefs.getCharPref('lastMajorVersion');
    var verComparator = Cc['@mozilla.org/xpcom/version-comparator;1'].
                        getService(Ci.nsIVersionComparator);

    if (verComparator.compare(prevVersion, LAST_MAJOR_VERSION) < 0) {
        var browser = document.getElementById('feed-view');
        browser.loadURI(RELEASE_NOTES_URL);
        gPrefs.setCharPref('lastMajorVersion', LAST_MAJOR_VERSION);
        return;
    }

    // Load the Unread view.
    if (gFeedList.tree && gFeedList.tree.view) {
        gFeedList.tree.view.selection.select(0);
        gFeedList.tree.focus();
    }
    else {
        // If the sidebar is hidden, then tree has no view and we have to manually
        // create the FeedView.
        var query = new QuerySH(null, null, true);
        var unreadFolder = document.getElementById('unread-folder');
        var title = unreadFolder.getAttribute('title');
        gFeedView = new FeedView(title, query);
    }
}


function updateProgressMeter() {
    var progressmeter = document.getElementById('update-progress');
    var progress = 100 * gUpdateService.completedFeedsCount /
                         gUpdateService.totalFeedsCount;
    progressmeter.value = progress;

    if (progress == 100) {
        setTimeout(function() {progressmeter.hidden = true}, 500);
        var deck = document.getElementById('update-buttons-deck');
        deck.selectedIndex = 0;
    }
}


function selectHomeFolder(aEvent) {
    var foldersTree = document.getElementById('bookmark-folders-tree');
    var selectedIndex = foldersTree.currentIndex;
    if (selectedIndex != -1) {
        var resource = foldersTree.treeBuilder.getResourceAtIndex(selectedIndex);
        gPrefs.setCharPref('liveBookmarksFolder', resource.Value);
    }
}


// Creates and manages a FeedView displaying the search results,
// based on the current input string and the search scope.
var previousView = null;
function performSearch(aEvent) {
    var searchbar = document.getElementById('searchbar');
    var bundle = document.getElementById('main-bundle');
    var title = bundle.getFormattedString('searchResults', [searchbar.value]);

    // If there's no feed view and the search scope is "current view" then do nothing.
    if (searchbar.searchScope == 0 && !gFeedView)
        return;

    // A new search is being started.
    if (searchbar.value && gFeedView && !gFeedView.query.searchString) {
        // Remember the old view to restore it after the search is finished.
        previousView = gFeedView;

        // For a global search we deselect items in the feed list.
        // We need to suppress selection so that gFeedList.onSelect() isn't used.
        // nsITreeSelection.selectEventsSuppressed doesn't seem to work here, so
        // we have to set our own flag which we will check in onSelect().
        if (searchbar.searchScope == 1) {
            gFeedList.ignoreSelectEvent = true;
            gFeedList.tree.view.selection.clearSelection();
            gFeedList.ignoreSelectEvent = false;
        }
    }

    // The search has finished.
    if (!searchbar.value && gFeedView) {
        if (previousView != gFeedView) {
            gFeedView = previousView;
            gFeedView.query.searchString = gFeedView.titleOverride = '';
            gFeedView.refresh();
            return;
        }

        gFeedView.query.searchString = gFeedView.titleOverride = '';
        gFeedView.ensure();
        return;
    }

    // If the search scope is set to "global" and there is no view or it is not
    // a global search view, then let's create it.
    if ((searchbar.searchScope == 1 && !gFeedView.isGlobalSearch) ||
       (searchbar.searchScope == 1 && !gFeedView)) {
        var query = new Query();
        query.searchString = searchbar.value;
        gFeedView = new FeedView(title, query);
        return;
    }

    gFeedView.titleOverride = title;
    gFeedView.query.searchString = searchbar.value;
    gFeedView.ensure();
}


function onKeyPress(aEvent) {
    // Stop propagation of character keys, to disable FAYT.
    if (aEvent.charCode)
        aEvent.stopPropagation();

    // Brief takes over these shortcut keys, so we stop the default action.
    // Let's not prevent the user from typing in inputs that entries may contain, though.
    if (!gPrefs.assumeStandardKeys || aEvent.originalTarget.localName == 'input')
        return;

    // We can't leave handling of Space and Tab to XUL like other keys,
    // because unlike them they have to be default-prevented.
    if (aEvent.keyCode == aEvent.DOM_VK_TAB) {
        gCommands.turnOffKeyNav();
        aEvent.preventDefault();
        return;
    }

    var searchbar = document.getElementById('searchbar');
    if (aEvent.charCode == aEvent.DOM_VK_SPACE && searchbar.getAttribute('focused') != 'true') {
        gCommands.selectNextEntry();
        aEvent.preventDefault();
        return;
    }

    if (aEvent.keyCode == aEvent.DOM_VK_BACK_SPACE && searchbar.getAttribute('focused') != 'true') {
        gCommands.selectPrevEntry();
        aEvent.preventDefault();
    }
}


var gPrefs = {

    register: function gPrefs_register() {
        this._branch = Cc['@mozilla.org/preferences-service;1'].
                       getService(Ci.nsIPrefService).
                       getBranch('extensions.brief.').
                       QueryInterface(Ci.nsIPrefBranch2);

        this.getIntPref = this._branch.getIntPref;
        this.getBoolPref = this._branch.getBoolPref;
        this.getCharPref = this._branch.getCharPref;
        this.getComplexValue = this._branch.getComplexValue;

        this.setIntPref = this._branch.setIntPref;
        this.setBoolPref = this._branch.setBoolPref;
        this.setCharPref = this._branch.setCharPref;

        // Cache prefs access to which is critical for performance.
        this.entriesPerPage = this.getIntPref('feedview.entriesPerPage');
        this.shownEntries = this.getCharPref('feedview.shownEntries');
        this.doubleClickMarks = this.getBoolPref('feedview.doubleClickMarks');
        this.showHeadlinesOnly = this.getBoolPref('feedview.showHeadlinesOnly');
        this.showAuthors = this.getBoolPref('feedview.showAuthors');
        this.keyNavEnabled = this.getBoolPref('feedview.keyNavEnabled');
        this.assumeStandardKeys = this.getBoolPref('assumeStandardKeys');

        this._branch.addObserver('', this, false);
    },

    unregister: function gPrefs_unregister() {
        this._branch.removeObserver('', this);
    },

    observe: function gPrefs_observe(aSubject, aTopic, aData) {
        if (aTopic != 'nsPref:changed')
            return;

        switch (aData) {
        case 'showFavicons':
            var feeds = gStorage.getAllFeeds({});
            gFeedList.refreshFeedTreeitems(feeds);
            break;

        case 'feedview.customStylePath':
            if (this.getBoolPref('feedview.useCustomStyle')) {
                gFeedViewStyle = getFeedViewStyle();
                if (gFeedView && gFeedView.isActive)
                    gFeedView.refresh();
            }
            break;

        case 'feedview.useCustomStyle':
            gFeedViewStyle = getFeedViewStyle();
            if (gFeedView && gFeedView.isActive)
                gFeedView.refresh();
            break;

        // Observers to keep the cached prefs up to date.
        case 'feedview.entriesPerPage':
            this.entriesPerPage = this.getIntPref('feedview.entriesPerPage');
            if (gFeedView && gFeedView.isActive)
                gFeedView.refresh();
            break;

        case 'feedview.shownEntries':
            this.shownEntries = this.getCharPref('feedview.shownEntries');
            var viewConstraintList = document.getElementById('view-constraint-list');
            viewConstraintList.selectedIndex = this.shownEntries == 'all' ? 0 :
                                               this.shownEntries == 'unread' ? 1 : 2;
            break;

        case 'feedview.doubleClickMarks':
            this.doubleClickMarks = this.getBoolPref('feedview.doubleClickMarks');
            break;
        case 'feedview.showHeadlinesOnly':
            this.showHeadlinesOnly = this.getBoolPref('feedview.showHeadlinesOnly');
            break;
        case 'feedview.showAuthors':
            this.showAuthors = this.getBoolPref('feedview.showAuthors');
            break;
        case 'feedview.keyNavEnabled':
            this.keyNavEnabled = this.getBoolPref('feedview.keyNavEnabled');
            break;
        case 'assumeStandardKeys':
            this.assumeStandardKeys = this.getBoolPref('assumeStandardKeys');
            break;
        }
    }

}


function dump(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage(aMessage);
}
