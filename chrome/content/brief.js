const EXT_ID = 'brief@mozdev.org';

const TEMPLATE_FILENAME = 'feedview-template.html';
const CUSTOM_STYLE_FILENAME = 'brief-custom-style.css';
const EXAMPLE_CUSTOM_STYLE_FILENAME = 'example-custom-style.css';
const DEFAULT_STYLE_URL = 'chrome://brief/skin/feedview.css';

const LAST_MAJOR_VERSION = '1.2';
const RELEASE_NOTES_URL = 'http://brief.mozdev.org/versions/1.2.html';

var Cc = Components.classes;
var Ci = Components.interfaces;

const gStorage = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
const gUpdateService = Cc['@ancestor/brief/updateservice;1'].getService(Ci.nsIBriefUpdateService);
var QuerySH = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery', 'setConstraints');
var Query = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery');

const ENTRY_STATE_NORMAL = Ci.nsIBriefQuery.ENTRY_STATE_NORMAL;
const ENTRY_STATE_TRASHED = Ci.nsIBriefQuery.ENTRY_STATE_TRASHED;
const ENTRY_STATE_DELETED = Ci.nsIBriefQuery.ENTRY_STATE_DELETED;
const ENTRY_STATE_ANY = Ci.nsIBriefQuery.ENTRY_STATE_ANY;

var gTopWindow = null;
var gTemplateURI = '';


function init() {
    gPrefs.register();

    initTemplateFile();

    if (gPrefs.homeFolder) {
        // Initiate the feed list (asynchronously, so that the window is displayed sooner).
        async(gFeedList.rebuild, 0, gFeedList);
        async(gStorage.syncWithBookmarks, 1000, gStorage);
    }
    else {
        showHomeFolderPicker();
    }

    gTopWindow = window.QueryInterface(Ci.nsIInterfaceRequestor).
                        getInterface(Ci.nsIWebNavigation).
                        QueryInterface(Ci.nsIDocShellTreeItem).
                        rootTreeItem.
                        QueryInterface(Ci.nsIInterfaceRequestor).
                        getInterface(Ci.nsIDOMWindow);

    initToolbarsAndStrings();

    document.addEventListener('keypress', onKeyPress, true);

    var observerService = Cc['@mozilla.org/observer-service;1'].
                          getService(Ci.nsIObserverService);

    observerService.addObserver(gObserver, 'brief:feed-updated', false);
    observerService.addObserver(gObserver, 'brief:feed-loading', false);
    observerService.addObserver(gObserver, 'brief:feed-error', false);
    observerService.addObserver(gObserver, 'brief:feed-update-queued', false);
    observerService.addObserver(gObserver, 'brief:feed-update-canceled', false);
    observerService.addObserver(gObserver, 'brief:custom-style-changed', false);

    observerService.addObserver(gFeedList, 'brief:invalidate-feedlist', false);
    observerService.addObserver(gFeedList, 'brief:feed-title-changed', false);

    gStorage.addObserver(gFeedList);

    async(loadHomeview);
}


function initTemplateFile() {
    var dataDir = Cc['@mozilla.org/extensions/manager;1'].
                  getService(Ci.nsIExtensionManager).
                  getInstallLocation(EXT_ID).
                  getItemLocation(EXT_ID);
    dataDir.append('defaults');
    dataDir.append('data');

    // Get the URI of the template file.
    var templateFile = dataDir.clone();
    templateFile.append(TEMPLATE_FILENAME);
    gTemplateURI = Cc['@mozilla.org/network/protocol;1?name=file'].
                   getService(Ci.nsIFileProtocolHandler).
                   newFileURI(templateFile);

    // Put the custom CSS file in %PROFILE_DIR%/chrome.
    var chromeDir = Cc['@mozilla.org/file/directory_service;1'].
                    getService(Ci.nsIProperties).
                    get('ProfD', Ci.nsIFile);
    chromeDir.append('chrome');
    var customStyleFile = chromeDir.clone();
    customStyleFile.append(CUSTOM_STYLE_FILENAME);
    if (!customStyleFile.exists()) {
        var defaultCustomStyle = dataDir;
        defaultCustomStyle.append(EXAMPLE_CUSTOM_STYLE_FILENAME);
        defaultCustomStyle.copyTo(chromeDir, CUSTOM_STYLE_FILENAME);
    }
}


function initToolbarsAndStrings() {
    getElement('headlines-checkbox').checked = gPrefs.showHeadlinesOnly;
    getElement('view-constraint-list').selectedIndex = gPrefs.shownEntries == 'all' ? 0 :
                                                       gPrefs.shownEntries == 'unread' ? 1 : 2;

    // Set show/hide sidebar button's tooltip.
    var pane = getElement('left-pane');
    var bundle = getElement('main-bundle');
    var tooltiptext = pane.hidden ? bundle.getString('showSidebarTooltip')
                                  : bundle.getString('hideSidebarTooltip');
    getElement('toggle-sidebar').setAttribute('tooltiptext', tooltiptext);

    // Cache the strings, so they don't have to retrieved every time when
    // refreshing the feed view.
    FeedView.prototype.todayStr = bundle.getString('today');
    FeedView.prototype.yesterdayStr = bundle.getString('yesterday');
    FeedView.prototype.authorPrefixStr = bundle.getString('authorIntroductionPrefix') + ' ';
    FeedView.prototype.updatedStr = bundle.getString('entryWasUpdated');
    FeedView.prototype.markAsReadStr = bundle.getString('markEntryAsRead');
    FeedView.prototype.markAsUnreadStr = bundle.getString('markEntryAsUnread');
}


function unload() {
    var observerService = Cc['@mozilla.org/observer-service;1'].
                          getService(Ci.nsIObserverService);
    observerService.removeObserver(gObserver, 'brief:feed-updated');
    observerService.removeObserver(gObserver, 'brief:feed-loading');
    observerService.removeObserver(gObserver, 'brief:feed-error');
    observerService.removeObserver(gObserver, 'brief:feed-update-queued');
    observerService.removeObserver(gObserver, 'brief:feed-update-canceled');

    observerService.removeObserver(gFeedList, 'brief:invalidate-feedlist');
    observerService.removeObserver(gFeedList, 'brief:feed-title-changed');

    gPrefs.unregister();
    gStorage.removeObserver(gFeedList);
}


// Storage and UpdateService components communicate with us through global notifications.
var gObserver = {

    observe: function gObserver_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

        case 'brief:feed-updated':
            var item = getElement(aData);
            item.removeAttribute('error');
            item.removeAttribute('loading');
            gFeedList.refreshFeedTreeitems(item);
            refreshProgressmeter();
            break;

        case 'brief:feed-loading':
            var item = getElement(aData);
            item.setAttribute('loading', true);
            gFeedList.refreshFeedTreeitems(item);
            break;

        // Error occured when downloading or parsing the feed, show error icon.
        case 'brief:feed-error':
            var item = getElement(aData);
            item.removeAttribute('loading');
            item.setAttribute('error', true);
            gFeedList.refreshFeedTreeitems(item);
            refreshProgressmeter();
            break;

        // Sets up the progressmeter and the stop button.
        case 'brief:feed-update-queued':
            getElement('update-buttons-deck').selectedIndex = 1;

            if (gUpdateService.scheduledFeedsCount > 1) {
                getElement('update-progress').hidden = false;
                refreshProgressmeter();
            }
            break;

        case 'brief:feed-update-canceled':
            var progressmeter = getElement('update-progress');
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

        case 'brief:custom-style-changed':
            gFeedView.browser.loadURI(gTemplateURI.spec);
            break;

        }
    }

}


var gCommands = {

    toggleSidebar: function cmd_toggleLeftPane() {
        var pane = getElement('left-pane');
        var splitter = getElement('left-pane-splitter');
        var button = getElement('toggle-sidebar');
        var bundle = getElement('main-bundle');

        pane.hidden = splitter.hidden = !pane.hidden;

        var tooltiptext = pane.hidden ? bundle.getString('showSidebarTooltip')
                                      : bundle.getString('hideSidebarTooltip');
        button.setAttribute('tooltiptext', tooltiptext);
        button.setAttribute('sidebarHidden', pane.hidden);

        if (gFeedList.treeNotBuilt)
            gFeedList.rebuild();
    },

    updateAllFeeds: function cmd_updateAllFeeds() {
        gUpdateService.updateAllFeeds();
    },

    stopUpdating: function cmd_stopUpdating() {
        gUpdateService.stopUpdating();
        getElement('update-buttons-deck').selectedIndex = 0;
    },

    openOptions: function cmd_openOptions(aPaneID) {
        var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                         getService(Ci.nsIPrefBranch);
        var instantApply = prefBranch.getBoolPref('browser.preferences.instantApply');
        var features = 'chrome,titlebar,toolbar,centerscreen,resizable,';
        features += instantApply ? 'modal=no,dialog=no' : 'modal';

        window.openDialog('chrome://brief/content/options/options.xul', 'Brief options',
                          features, aPaneID);
    },

    markViewRead: function cmd_markViewRead(aEvent) {
        var query = gFeedView.query;

        if (aEvent.ctrlKey) {
            query.offset = gPrefs.entriesPerPage * (gFeedView.currentPage - 1);
            query.limit = gPrefs.entriesPerPage;
        }

        query.markEntriesRead(true);
    },

    switchHeadlinesView: function cmd_switchHeadlinesView() {
        var newState = !gPrefs.showHeadlinesOnly;
        gPrefs.setBoolPref('feedview.showHeadlinesOnly', newState);

        getElement('headlines-checkbox').checked = newState;

        var entries = gFeedView.feedContent.childNodes;
        for (var i = 0; i < entries.length; i++)
            gFeedView.collapseEntry(parseInt(entries[i].id), newState, false);

        if (newState) {
            gFeedView.feedContent.setAttribute('showHeadlinesOnly', true);
        }
        else {
            gFeedView.feedContent.removeAttribute('showHeadlinesOnly');
            gFeedView.markVisibleAsRead();
        }
    },

    changeViewConstraint: function cmd_changeViewConstraint(aConstraint) {
        if (gPrefs.shownEntries != aConstraint) {
            gPrefs.setCharPref('feedview.shownEntries', aConstraint);

            gFeedView.refresh();
        }
    },

    switchSelectedEntryRead: function cmd_switchSelectedEntryRead() {
        if (gFeedView.selectedEntry) {
            var newState = !gFeedView.selectedElement.hasAttribute('read');
            this.markEntryRead(gFeedView.selectedEntry, newState);
        }
    },

    markEntryRead: function cmd_markEntryRead(aEntry, aNewState) {
        var query = new QuerySH(null, [aEntry], null);
        query.deleted = ENTRY_STATE_ANY;
        query.markEntriesRead(aNewState);

        if (gPrefs.autoMarkRead && !aNewState)
            gFeedView.entriesMarkedUnread.push(aEntry);
    },

    deleteSelectedEntry: function cmd_deleteSelectedEntry() {
        if (gFeedView.selectedEntry)
            this.deleteEntry(gFeedView.selectedEntry);
    },

    deleteEntry: function cmd_deleteEntry(aEntry) {
        var query = new QuerySH(null, [aEntry], null);
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },

    restoreSelectedEntry: function cmd_restoreSelectedEntry() {
        if (gFeedView.selectedEntry)
            this.restoreEntry(gFeedView.selectedEntry);
    },

    restoreEntry: function cmd_restoreEntry(aEntry) {
        var query = new QuerySH(null, [aEntry], null);
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_NORMAL);
    },

    switchSelectedEntryStarred: function cmd_switchSelectedEntryStarred() {
        if (gFeedView.selectedEntry) {
            var newState = !gFeedView.selectedElement.hasAttribute('starred');
            this.starEntry(gFeedView.selectedEntry, newState);
        }
    },

    starEntry: function cmd_starEntry(aEntry, aNewState) {
        var query = new QuerySH(null, [aEntry], null);
        query.starEntries(aNewState);
    },

    switchSelectedEntryCollapsed: function cmd_switchSelectedEntryCollapsed() {
        if (gFeedView.selectedEntry && gPrefs.showHeadlinesOnly) {
            var selectedElement = gFeedView.selectedElement;
            var newState = !selectedElement.hasAttribute('collapsed');

            gFeedView.collapseEntry(gFeedView.selectedEntry, newState, true);

            function scroll() {
                var win = gFeedView.document.defaultView;
                var alignWithTop = (selectedElement.offsetHeight > win.innerHeight);
                selectedElement.scrollIntoView(alignWithTop);
            }
            async(scroll, 310);
        }
    },


    openSelectedEntryLink: function cmd_openSelectedEntryLink(aForceNewTab) {
        if (gFeedView.selectedEntry) {
            var newTab = gPrefs.getBoolPref('feedview.openEntriesInTabs') || aForceNewTab;
            gCommands.openEntryLink(gFeedView.selectedElement, newTab);
        }
    },

    openEntryLink: function cmd_openEntryLink(aEntryElement, aNewTab) {
        var url = aEntryElement.getAttribute('entryURL');

        if (aNewTab) {
            var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                             getService(Ci.nsIPrefBranch);
            var whereToOpen = prefBranch.getIntPref('browser.link.open_newwindow');
            if (whereToOpen == 2)
                openDialog('chrome://browser/content/browser.xul', '_blank', 'chrome,all,dialog=no', url);
            else
                gTopWindow.gBrowser.loadOneTab(url);
        }
        else {
            gFeedView.browser.loadURI(url);
        }

        if (!aEntryElement.hasAttribute('read')) {
            aEntryElement.setAttribute('read', true);
            var query = new QuerySH(null, [parseInt(aEntryElement.id)], null);
            query.markEntriesRead(true);
        }
    },

    displayShortcuts: function cmd_displayShortcuts() {
        if (gFeedView.isActive) {
            var evt = document.createEvent('Events');
            evt.initEvent('DisplayShortcuts', false, false);
            gFeedView.document.dispatchEvent(evt);
        }
    }
}


function loadHomeview() {
    var query = new QuerySH(null, null, true);
    var title = getElement('unread-folder').getAttribute('title');
    var view = new FeedView(title, query);

    var prevVersion = gPrefs.getCharPref('lastMajorVersion');
    var verComparator = Cc['@mozilla.org/xpcom/version-comparator;1'].
                        getService(Ci.nsIVersionComparator);

    // If Brief has been updated, load the new version info page.
    if (verComparator.compare(prevVersion, LAST_MAJOR_VERSION) < 0) {
        var browser = getElement('feed-view');
        browser.loadURI(RELEASE_NOTES_URL);
        gPrefs.setCharPref('lastMajorVersion', LAST_MAJOR_VERSION);

        gFeedView = view; // Set the view without attaching it.
    }
    else {
        view.attach();

        if (gFeedList.tree && gFeedList.tree.view) {
            gFeedList.ignoreSelectEvent = true;
            gFeedList.tree.view.selection.select(0);
            gFeedList.ignoreSelectEvent = false;
            gFeedList.tree.focus();
        }
    }
}


function refreshProgressmeter() {
    var progressmeter = getElement('update-progress');
    var progress = 100 * gUpdateService.completedFeedsCount /
                         gUpdateService.scheduledFeedsCount;
    progressmeter.value = progress;

    if (progress == 100) {
        async(function() { progressmeter.hidden = true }, 500);
        getElement('update-buttons-deck').selectedIndex = 0;
    }
}

function showHomeFolderPicker() {
    getElement('feed-list-deck').selectedIndex = 1;

    var query = PlacesUtils.history.getNewQuery();
    var options = PlacesUtils.history.getNewQueryOptions();
    query.setFolders([PlacesUIUtils.allBookmarksFolderId], 1);
    options.excludeItems = true;

    getElement('places-tree').load([query], options);
}


function selectHomeFolder(aEvent) {
    var placesTree = getElement('places-tree');
    if (placesTree.currentIndex != -1) {
        var folderId = PlacesUtils.getConcreteItemId(placesTree.selectedNode);
        gPrefs.setIntPref('homeFolder', folderId);
    }
}


// Creates and manages a FeedView displaying the search results,
// based on the current input string and the search scope.
var previousView = null;
var previousSelectedIndex = -1;
function performSearch(aEvent) {
    var searchbar = getElement('searchbar');

    // If new search is being started, remember the old view to
    // restore it after the search is finished.
    if (!gFeedView.query.searchString) {
        previousView = gFeedView;
        previousSelectedIndex = gFeedList.tree.currentIndex;
    }

    var bundle = getElement('main-bundle');
    var titleOverride = bundle.getFormattedString('searchResults', [searchbar.value]);

    // If the search scope is set to global but the view is not the
    // global search view, then let's create it.
    if (searchbar.searchScope == 1 && !gFeedView.isGlobalSearch) {
        gFeedList.ignoreSelectEvent = true;
        gFeedList.tree.view.selection.clearSelection();
        gFeedList.ignoreSelectEvent = false;

        var query = new Query();
        query.searchString = searchbar.value;
        var title = bundle.getFormattedString('searchResults', ['']);
        var view = new FeedView(title, query);
        view.titleOverride = titleOverride;
        view.attach();
    }
    else {
        gFeedView.titleOverride = searchbar.value ? titleOverride : '';
        gFeedView.query.searchString = searchbar.value;
        gFeedView.refresh();
    }
}

// Restores the view and the tree selection from before the search was started.
function finishSearch() {
    if (previousSelectedIndex != -1) {
        gFeedList.ignoreSelectEvent = true;
        gFeedList.tree.view.selection.select(previousSelectedIndex);
        gFeedList.ignoreSelectEvent = false;
    }

    if (previousView && previousView != gFeedView) {
        previousView.attach();
        gFeedView.query.searchString = gFeedView.titleOverride = '';
    }
    else {
        gFeedView.query.searchString = gFeedView.titleOverride = '';
        gFeedView.refresh();
    }

    previousView = null;
    previousSelectedIndex = -1;
}


/**
 * We can't leave handling of Space, Tab, and Backspace can't be captured using <key>
 * XUL elements, so we handle them manually using a listener.
 * Additionally, unlike other keys, they have to be default-prevented.
 */
function onKeyPress(aEvent) {
    // Stop propagation of character keys, to disable FAYT.
    if (aEvent.charCode)
        aEvent.stopPropagation();

    // Brief takes over these shortcut keys, so we stop the default action.
    // Let's not prevent the user from typing in inputs that entries may contain, though.
    if (gPrefs.getBoolPref('assumeStandardKeys') && aEvent.originalTarget.localName != 'input') {

        if (aEvent.keyCode == aEvent.DOM_VK_TAB && !aEvent.ctrlKey) {
            gPrefs.setBoolPref('feedview.entrySelectionEnabled',
                               !gPrefs.entrySelectionEnabled);
            aEvent.preventDefault();
        }
        else if (aEvent.charCode == aEvent.DOM_VK_SPACE) {
            if (gPrefs.entrySelectionEnabled)
                gFeedView.selectNextEntry();
            else
                gFeedView.scrollToNextEntry(true);

            aEvent.preventDefault();
        }
        else if (aEvent.keyCode == aEvent.DOM_VK_BACK_SPACE) {
            if (gPrefs.entrySelectionEnabled)
                gFeedView.selectPrevEntry();
            else
                gFeedView.scrollToPrevEntry(true);

            aEvent.preventDefault();
        }
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

        for each (pref in this._cachedPrefs)
            this._updateCachedPref(pref);

        this._branch.addObserver('', this, false);
    },

    unregister: function gPrefs_unregister() {
        this._branch.removeObserver('', this);
    },


    get homeFolder gPrefs_homeFolder() {
        var pref = this.getIntPref('homeFolder');
        return (pref != -1) ? pref : null;
    },

    _cachedPrefs:
        [{ name: 'feedview.doubleClickMarks',       propName: 'doubleClickMarks' },
         { name: 'feedview.showHeadlinesOnly',      propName: 'showHeadlinesOnly' },
         { name: 'feedview.entrySelectionEnabled',  propName: 'entrySelectionEnabled' },
         { name: 'feedview.autoMarkRead',           propName: 'autoMarkRead' },
         { name: 'feedview.shownEntries',           propName: 'shownEntries' },
         { name: 'feedview.entriesPerPage',         propName: 'entriesPerPage' },
         { name: 'feedview.sortUnreadViewOldestFirst', propName: 'sortUnreadViewOldestFirst' }],

    _updateCachedPref: function gPrefs__updateCachedPref(aPref) {
        switch (this._branch.getPrefType(aPref.name)) {
            case Ci.nsIPrefBranch.PREF_STRING:
                this[aPref.propName] = this.getCharPref(aPref.name);
                break;
            case Ci.nsIPrefBranch.PREF_INT:
                this[aPref.propName] = this.getIntPref(aPref.name);
                break;
            case Ci.nsIPrefBranch.PREF_BOOL:
                this[aPref.propName] = this.getBoolPref(aPref.name);
                break;
        }
    },


    observe: function gPrefs_observe(aSubject, aTopic, aData) {
        if (aTopic != 'nsPref:changed')
            return;

        for each (pref in this._cachedPrefs) {
            if (aData == pref.name)
                this._updateCachedPref(pref);
        }

        switch (aData) {
            case 'feedview.entriesPerPage':
                gFeedView.refresh();
                break;
            case 'feedview.shownEntries':
                var list = getElement('view-constraint-list');
                list.selectedIndex = this.shownEntries == 'all' ? 0 :
                                     this.shownEntries == 'unread' ? 1 : 2;
                break;
            case 'feedview.autoMarkRead':
                if (this.autoMarkRead && gFeedView)
                    gFeedView.markVisibleAsRead();
                break;
            case 'feedview.sortUnreadViewOldestFirst':
                if (gFeedView.query.unread) {
                    gFeedView.query.sortDirection = this.sortUnreadViewOldestFirst
                                                    ? Ci.nsIBriefQuery.SORT_ASCENDING
                                                    : Ci.nsIBriefQuery.SORT_DESCENDING;
                    gFeedView.refresh();
                }
                break;
            case 'feedview.entrySelectionEnabled':
                gFeedView.toggleEntrySelection();
                break;
        }
    }

}


// Utility functions.


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

function intersect(arr1, arr2) {
    for (let i = 0; i < arr1.length; i++) {
        if (arr2.indexOf(arr1[i]) != -1)
            return true;
    }
    return false;
}

function filterDuplicates(arr) {
    var retval = [];
    for (let i = 0; i < arr.length; i++) {
        if (retval.indexOf(arr[i]) == -1)
            retval.push(arr[i]);
    }
    return retval;
}




function log(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage(aMessage);
}
