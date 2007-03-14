const EXT_ID = 'brief@mozdev.org';
const TEMPLATE_PATH = '/defaults/data/feedview-template.html';
const JQUERY_PATH = '/defaults/data/jquery.js';
const DEFAULT_STYLE_PATH = 'chrome://brief/skin/feedview.css'
const Cc = Components.classes;
const Ci = Components.interfaces;

var gFeedView;
var gStorage;
var gTemplateURL;
var gFeedViewStyle;

var brief = {

    briefLoaded: false,

    init: function(aEvent) {
        if (this.briefLoaded)
            return;
        this.briefLoaded = true;

        // Get the global services.
        gStorage = Cc['@mozilla.org/brief/storage;1'].createInstance(Ci.nsIBriefStorage);
        gPrefs.register();
        gFeedViewStyle = this.getFeedViewStyle();

        // Get the extension's directory.
        var extensionDir = Cc['@mozilla.org/extensions/manager;1'].
                           getService(Ci.nsIExtensionManager).
                           getInstallLocation(EXT_ID).
                           getItemLocation(EXT_ID).
                           path;
        // Replace backslashes with slashes.
        var regexp = new RegExp('%5C', 'g');
        extensionDir = escape(extensionDir).replace(regexp, '/');
        // Construct the final URL.
        gTemplateURL = 'file:///' + extensionDir + TEMPLATE_PATH;
        gTemplateURL = unescape(gTemplateURL);

        // Initiate the feed list.
        var liveBookmarksFolder = gPrefs.getCharPref('liveBookmarksFolder');
        if (liveBookmarksFolder) {
            gStorage.syncWithBookmarks();
            setTimeout(function(){ gFeedList.rebuild(); }, 0);
        }
        else {
            // If no Live Bookmarks folder has been picked yet, offer a button to do it.
            var deck = document.getElementById('feed-list-deck');
            deck.selectedIndex = 1;
        }

        this.browserWindow = window.QueryInterface(Ci.nsIInterfaceRequestor).
                                    getInterface(Ci.nsIWebNavigation).
                                    QueryInterface(Ci.nsIDocShellTreeItem).
                                    rootTreeItem.
                                    QueryInterface(Ci.nsIInterfaceRequestor).
                                    getInterface(Ci.nsIDOMWindow);

        var viewConstraintList = document.getElementById('view-constraint-list');
        viewConstraintList.selectedIndex = gPrefs.shownEntries == 'all' ? 0 :
                                           gPrefs.shownEntries == 'unread' ? 1 : 2;

        var observerService = Cc["@mozilla.org/observer-service;1"].
                              getService(Ci.nsIObserverService);
        observerService.addObserver(this, 'brief:feed-updated', false);
        observerService.addObserver(this, 'brief:feed-loading', false);
        observerService.addObserver(this, 'brief:feed-error', false);
        observerService.addObserver(this, 'brief:entry-status-changed', false);
        observerService.addObserver(this, 'brief:sync-to-livemarks', false);
        observerService.addObserver(this, 'brief:batch-update-started', false);
    },


    unload: function() {
        var observerService = Cc["@mozilla.org/observer-service;1"].
                              getService(Ci.nsIObserverService);
        observerService.removeObserver(this, 'brief:feed-updated');
        observerService.removeObserver(this, 'brief:feed-loading');
        observerService.removeObserver(this, 'brief:feed-error');
        observerService.removeObserver(this, 'brief:sync-to-livemarks');
        observerService.removeObserver(this, 'brief:entry-status-changed');
        observerService.removeObserver(this, 'brief:batch-update-started');
        gPrefs.unregister();
    },


    // Storage and UpdateService components communicate with us through global
    // notifications.
    observe: function(aSubject, aTopic, aData) {
        switch (aTopic) {
            // A feed update was finished and new entries are available. Restore the
            // favicon instead of the throbber (or error icon), refresh the feed treeitem
            // and the feedview if necessary.
            case 'brief:feed-updated':
                var feedId = aData;
                var item = gFeedList.getTreeitemForFeed(feedId);
                item.removeAttribute('error');
                item.removeAttribute('loading');
                gFeedList.refreshFeedTreeitem(feedId, item);
                this.finishedFeeds++;
                this.updateProgressMeter();

                if (aSubject.QueryInterface(Ci.nsIVariant) > 0) {
                  gFeedList.refreshSpecialTreeitem('unread-folder');

                  // If the the updated feed is currently being displayed,
                  // refresh the feed view.
                  if (gFeedView && gFeedView.feedViewActive &&
                      ( (!gFeedView.feedId && gFeedView.rules == 'unread') ||
                        (gFeedView.feedId && gFeedView.feedId.match(feedId))  ))
                    gFeedView.refresh();
                }
                break;

            // A feed was requested, show throbber as its icon.
            case 'brief:feed-loading':
                var item = gFeedList.getTreeitemForFeed(aData);
                item.setAttribute('loading', true);
                gFeedList.refreshFeedTreeitem(aData, item);
                break;

            // An error occured when downloading or parsing a feed, show error icon.
            case 'brief:feed-error':
                var feedId = aData;
                var item = gFeedList.getTreeitemForFeed(feedId);
                gFeedList.removeProperty(item, 'loading');
                item.setAttribute('error', true);
                gFeedList.refreshFeedTreeitem(feedId, item);
                this.finishedFeeds++;
                this.updateProgressMeter();
                break;

            // The Live Bookmarks stored is user's folder of choice were read and the
            // in-database list of feeds was synchronized. Rebuild the feed list as it
            // may have changed.
            case 'brief:sync-to-livemarks':
                gFeedList.rebuild();
                var deck = document.getElementById('feed-list-deck');
                deck.selectedIndex = 0;
                break;

            // Sets up the updating progressmeter.
            case 'brief:batch-update-started':
                var progressmeter = document.getElementById('update-progress');
                progressmeter.hidden = false;
                progressmeter.value = 0;
                this.totalFeeds = gStorage.getAllFeeds({}).length;
                this.finishedFeeds = 0;
                break;

            // Entries were marked as read/unread, starred, trashed, restored, or deleted.
            case 'brief:entry-status-changed':
                this.onEntryStatusChanged(aSubject, aData);
        }
    },

    // Updates the approperiate treeitems in the feed list and refreshes the feedview
    // when necessary.
    onEntryStatusChanged: function(aChangedItems, aChangeType) {
        aChangedItems.QueryInterface(Ci.nsIWritablePropertyBag2);
        var changedFeeds = aChangedItems.getPropertyAsAUTF8String('feedIdList');
        var changedEntries = aChangedItems.getPropertyAsAUTF8String('entryIdList');

        // We break down the list of feeds which changed entries belong to and
        // update their treeitems.
        var feeds = changedFeeds.match(/[^ ]+/g);
        var entries = changedEntries.match(/[^ ]+/g);

        switch (aChangeType) {
            case 'unread':
            case 'read':
                // If view is set to show only unread entries, we need to refresh it if
                // any of the shown entries have been marked as read.
                // We take advantage of the fact that when only unread entries are shown
                // it is impossible to mark any entry as unread. Thus, entries can never
                // be added to such view which simplifies a lot. See analogical situation
                // when only starred entries are shown.
                if (gFeedView && gFeedView.feedViewActive && gFeedView.rules == 'unread')
                    gFeedView.refreshWhenEntriesRemoved(entries);

                // Otherwise, we just visually mark the changed entries as read/unread.
                else if (gFeedView && gFeedView.feedViewActive) {
                    var nodes = gFeedView.feedContentDiv.childNodes;
                    for (var i = 0; i < nodes.length; i++) {
                        if (changedEntries.match(entries[i])) {
                            if (aChangeType == 'read')
                                nodes[i].setAttribute('read', 'true');
                            else
                                nodes[i].removeAttribute('read');
                        }
                    }
                }

                for (var i = 0; i < feeds.length; i++)
                    gFeedList.refreshFeedTreeitem(feeds[i])

                // We can't know if any of those need updating, so we have to
                // update them all.
                gFeedList.refreshSpecialTreeitem('unread-folder');
                gFeedList.refreshSpecialTreeitem('starred-folder');
                gFeedList.refreshSpecialTreeitem('trash-folder');
                break;

            case 'starred':
                if (gFeedView && gFeedView.feedViewActive && gFeedView.rules == 'starred')
                    gFeedView.refreshWhenEntriesRemoved(entries);
                gFeedList.refreshSpecialTreeitem('starred-folder');
                break;

            case 'deleted':
                if (gFeedView && gFeedView.feedViewActive)
                    gFeedView.refreshWhenEntriesRemoved(entries);

                for (var i = 0; i < feeds.length; i++)
                    gFeedList.refreshFeedTreeitem(feeds[i])

                gFeedList.refreshSpecialTreeitem('unread-folder');
                gFeedList.refreshSpecialTreeitem('starred-folder');
                gFeedList.refreshSpecialTreeitem('trash-folder');
                break;
        }
    },


    // Returns a string containing the style of the feed view.
    getFeedViewStyle: function() {
        if (gPrefs.getBoolPref('feedview.useCustomStyle')) {
            var pref = gPrefs.getComplexValue('feedview.customStylePath',
                                              Ci.nsISupportsString);
            var url = 'file:///' + pref.data;
        }
        else
            var url = DEFAULT_STYLE_PATH;

        var request = new XMLHttpRequest;
        request.open('GET', url, false);
        request.send(null);

        return request.responseText;
    },


    updateProgressMeter: function() {
        var progressmeter = document.getElementById('update-progress');
        var percentage = 100 * this.finishedFeeds / this.totalFeeds;
        progressmeter.value = percentage;

        if (percentage == 100)
            progressmeter.hidden = true;
    },

// Listeners for actions performed in the feed view.

    onMarkEntryRead: function(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var readStatus = aEvent.target.hasAttribute('read') ? true : false;
        gStorage.markEntriesRead(readStatus, entryID, null, null, null);
    },

    onDeleteEntry: function(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        gStorage.deleteEntries(1, entryID, null, null, null);
    },

    onRestoreEntry: function(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        gStorage.deleteEntries(0, entryID, null, null, null);
    },

    onStarEntry: function(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var newStatus = aEvent.target.hasAttribute('starred');
        gStorage.starEntry(entryID, newStatus);
    },

    onFeedViewClick: function(aEvent) {
        var anonid = aEvent.originalTarget.getAttribute('anonid');
        var targetEntry = aEvent.target;

        if (anonid == 'article-title-link' && (aEvent.button == 0 || aEvent.button == 1)) {

            if (gPrefs.getBoolPref('feedview.openEntriesInTabs')) {
                aEvent.preventDefault();
                var url = targetEntry.getAttribute('entryURL');
                brief.browserWindow.gBrowser.loadOneTab(url);
            }

            if (!targetEntry.hasAttribute('read') &&
                gPrefs.getBoolPref('feedview.linkMarksRead')) {
                targetEntry.setAttribute('read', true);
                var id = targetEntry.getAttribute('id');
                gStorage.markEntriesRead(true, id, null, null, null);
            }
        }
    },

// Toolbar commands.

    toggleLeftPane: function(aEvent) {
        var pane = document.getElementById('left-pane');
        var splitter = document.getElementById('left-pane-splitter');
        pane.hidden = splitter.hidden = !pane.hidden;
    },

    updateAllFeeds: function() {
        var updateService = Cc['@mozilla.org/brief/updateservice;1'].
                            createInstance(Ci.nsIBriefUpdateService);
        updateService.fetchAllFeeds();
    },

    openOptions: function(aPaneID) {
        var features = 'toolbar,centerscreen,modal,resizable';
        window.openDialog('chrome://brief/content/options/options.xul', null, features);
    },

    showNextPage: function() {
        gFeedView.currentPage++;
        gFeedView.refresh();
    },

    showPrevPage: function() {
        gFeedView.currentPage--;
        gFeedView.refresh();
    },

    onConstraintListCmd: function(aEvent) {
        var choice = aEvent.target.id;
        var prefValue = choice == 'show-all' ? 'all' :
                        choice == 'show-unread' ? 'unread' : 'starred';

        gPrefs.setCharPref('feedview.shownEntries', prefValue);
        gFeedView.refresh();
    },


    markCurrentViewRead: function(aNewStatus) {
        // Optimization not to call markEntriesRead when there's nothing to mark.
        // We check the number of entries that need to be marked.
        var oldStatus = aNewStatus ? 'unread' : 'read';
        var rules = gFeedView.rules + ' ' + oldStatus;
        var entriesToMarkCount = gStorage.getEntriesCount(gFeedView.feedId, rules,
                                                          gFeedView.searchString);
        if (entriesToMarkCount)
            gStorage.markEntriesRead(aNewStatus, null, gFeedView.feedId, gFeedView.rules,
                                     gFeedView.searchString);
    },


    performSearch: function(aEvent) {
        var searchbar = document.getElementById('searchbar');

        // For a global search we create a new FeedView, so let's do it if we didn't yet.
        if (searchbar.searchScope == 1 && (!gFeedView || !gFeedView.isGlobalSearchView)) {

            // We need to suppress selection so that gFeedList.onselect() isn't used.
            // nsITreeSelection.selectEventsSuppressed doesn't seem to work here, so
            // we have to set our own flag which we will check in onselect().
            var selection = gFeedList.tree.view.selection;
            gFeedList.selectEventsSuppressed = true;
            selection.clearSelection();
            gFeedList.selectEventsSuppressed = false;

            gFeedView = new FeedView(null, null, searchbar.value);
            gFeedView.isGlobalSearchView = true;
        }
        else if (gFeedView) {
            gFeedView.searchString = searchbar.value;
            gFeedView.refresh();
        }
    },

// Feed list context menu commands.

    ctx_markFeedRead: function(aEvent) {
        var item = gFeedList.ctx_targetItem;
        var feedId = gFeedList.ctx_targetItem.getAttribute('feedId');
        gStorage.markEntriesRead(true, null, feedId, null, null);
    },

    ctx_markFolderRead: function(aEvent) {
        var item = gFeedList.ctx_targetItem;

        if (item.hasAttribute('specialView')) {
            var rule = item.id == 'unread-folder' ? 'unread' :
                       item.id == 'starred-folder' ? 'starred' : 'trashed';
            gStorage.markEntriesRead(true, null, null, rule, null);
        }
        else {
            var feedItems = item.getElementsByTagName('treecell');
            var feedIds = '';
            for (var i = 0; i < feedItems.length; i++)
                feedIds += feedItems[i].getAttribute('feedId') + ' ';
            gStorage.markEntriesRead(true, null, feedIds, null, null);
        }
    },

    ctx_updateFeed: function(aEvent) {
        var feedId = gFeedList.ctx_targetItem.getAttribute('feedId');
        var updateService = Cc['@mozilla.org/brief/updateservice;1'].
                            createInstance(Ci.nsIBriefUpdateService);
        updateService.fetchFeed(feedId);
    },

    ctx_openWebsite: function(aEvent) {
        var feedId = gFeedList.ctx_targetItem.getAttribute('feedId');
        var url = gStorage.getFeed(feedId).websiteURL;
        brief.browserWindow.gBrowser.loadOneTab(url);
    },

    ctx_emptyFeed: function(aEvent) {
        var feedId = gFeedList.ctx_targetItem.getAttribute('feedId');
        gStorage.deleteEntries(1, null, feedId, null, null);
    },

    ctx_emptyFolder: function(aEvent) {
        var item = gFeedList.ctx_targetItem;
        var feedItems = item.getElementsByTagName('treecell');
        var feedIds = '';
        for (var i = 0; i < feedItems.length; i++)
            feedIds += feedItems[i].getAttribute('feedId') + ' ';
        gStorage.deleteEntries(1, null, feedIds, null, null);
    },

    ctx_restoreTrashed: function(aEvent) {
        gStorage.deleteEntries(0, null, null, 'trashed', null);
    },

    ctx_emptyTrash: function(aEvent) {
        gStorage.deleteEntries(2, null, null, 'trashed', null);
    }

}


var gPrefs = {

    register: function() {
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

        // Cache prefs access to which is critical for performance
        this.entriesPerPage = this.getIntPref('feedview.entriesPerPage');
        this.shownEntries = this.getCharPref('feedview.shownEntries');
        this.doubleClickMarks = this.getBoolPref('feedview.doubleClickMarks');

        this._branch.addObserver('', this, false);
    },

    unregister: function() {
        this._branch.removeObserver('', this);
    },

    observe: function(aSubject, aTopic, aData) {
        if (aTopic != 'nsPref:changed')
            return;
        switch (aData) {
            case 'showFavicons':
                var feeds = gStorage.getAllFeeds({});
                for (var i = 0; i < feeds.length; i++)
                    gFeedList.refreshFeedTreeitem(feeds[i].feedId);
                break;

            case 'feedview.customStylePath':
                if (this.getBoolPref('feedview.useCustomStyle'))
                    gFeedViewStyle = brief.getFeedViewStyle();
                break;

            case 'feedview.useCustomStyle':
                gFeedViewStyle = brief.getFeedViewStyle();
                break;

            // Observers to keep the cached prefs up to date
            case 'feedview.entriesPerPage':
                this.entriesPerPage = this.getIntPref('feedview.entriesPerPage');
                break;
            case 'feedview.shownEntries':
                this.shownEntries = this.getCharPref('feedview.shownEntries');
                break;
            case 'feedview.doubleClickMarks':
                this.doubleClickMarks = this.getBoolPref('feedview.doubleClickMarks');
                break;
        }
    }

}

function dump(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n ' + aMessage);
}
