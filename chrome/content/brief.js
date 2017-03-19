Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/API.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/NetUtil.jsm');
Components.utils.import("resource://gre/modules/PromiseUtils.jsm");

IMPORT_COMMON(this);

// Randomize URI to work around mozilla bug 918033
const STRINGS = Services.strings.createBundle('chrome://brief/locale/brief.properties?' + Math.random());

var gCurrentView;

var API = null;


var init = function* init() {
    API = new BriefClient(window);
    yield API.ready();

    PrefObserver.register();

    // Restore local persistence
    Persistence.init();

    Commands.switchViewFilter(Persistence.data.view.filter);

    refreshProgressmeter();

    API.addObserver(FeedList);

    API.addStorageObserver(FeedList);

    let selectedLocale = API.getLocale();
    let doc = getElement('feed-view').contentDocument;
    doc.documentElement.setAttribute('lang', selectedLocale);

    ViewList.init();

    SplitterModule.init();
    ContextMenuModule.init();

    Shortcuts.init();

    getElement('feed-list').setAttribute("closedFolders", Persistence.data.closedFolders);
    getElement('tag-list').style.width = Persistence.data.tagList.width;
    getElement('sidebar').style.width = Persistence.data.sidebar.width;
    document.body.classList.toggle('sidebar', !Persistence.data.sidebar.hidden);

    // Are we called to subscribe for a feed?
    let url = (new URLSearchParams(document.location.search)).get('subscribe');
    if(url !== null) {
        window.history.replaceState({}, "", BRIEF_URL);
        FeedList.rebuild(); // Adding a feed may take some time, so show the other feeds for now.
        yield API.addFeed(url);
    } else {
        ViewList.selectedItem = getElement(Persistence.data.startView || 'all-items-folder');
        yield wait();
    }

    FeedList.rebuild(url);
}.task()


function unload() {
    Persistence.save();

    API.removeObserver(FeedList);

    PrefObserver.unregister();
    API.removeStorageObserver(FeedList);
    gCurrentView.uninit();
    API.finalize();
}


var Commands = {

    hideSidebar: function cmd_hideSidebar() {
        document.body.classList.remove('sidebar');
    },

    revealSidebar: function cmd_revealSidebar() {
        document.body.classList.add('sidebar');
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
        API.query.markEntriesRead(gCurrentView.query, true);
    },

    markVisibleEntriesRead: function cmd_markVisibleEntriesRead() {
        gCurrentView.markVisibleEntriesRead();
    },

    switchViewMode: function cmd_switchViewMode(aMode) {
        if (FeedList.selectedFeed) {
            API.modifyFeed({
                feedID: FeedList.selectedFeed.feedID,
                viewMode: (aMode === 'headlines')
            });
        }
        else {
            Persistence.data.view.mode = aMode;
        }

        gCurrentView.refresh();
    },

    switchViewFilter: function cmd_switchViewFilter(aFilter) {
        Persistence.data.view.filter = aFilter;

        getElement('show-all-entries-checkbox').dataset.checked = (aFilter === 'all');
        getElement('filter-unread-checkbox').dataset.checked = (aFilter === 'unread');
        getElement('filter-starred-checkbox').dataset.checked = (aFilter === 'starred');

        if(gCurrentView !== undefined)
            gCurrentView.refresh();
    },

    openFeedWebsite: function cmd_openWebsite(aFeed) {
        let feed = aFeed ? aFeed : FeedList.selectedFeed;
        let url = feed.websiteURL || Services.io.newURI(feed.feedURL).host;
        getTopWindow().gBrowser.loadOneTab(url);
    },

    emptyFeed: function cmd_emptyFeed(aFeed) {
        let feed = aFeed ? aFeed : FeedList.selectedFeed;
        let query = {
            deleted: false,
            starred: false,
            feeds: [feed.feedID]
        };
        API.query.deleteEntries(query, 'trashed');
    },

    deleteFeed: function cmd_deleteFeed(aFeed) {
        let feed = aFeed ? aFeed : FeedList.selectedFeed;
        let title = STRINGS.GetStringFromName('confirmFeedDeletionTitle');
        let text = STRINGS.formatStringFromName('confirmFeedDeletionText', [feed.title], 1);

        if (Services.prompt.confirm(window, title, text))
            API.deleteFeed(Number(feed.bookmarkID));
    },

    restoreTrashed: function cmd_restoreTrashed() {
        ViewList.getQueryForView('trash-folder')
        API.query.deleteEntries(ViewList.getQueryForView('trash-folder'), false);
    },

    emptyTrash: function cmd_emptyTrash() {
        API.query.deleteEntries(ViewList.getQueryForView('trash-folder'), 'deleted');
    },

    toggleSelectedEntryRead: function cmd_toggleSelectedEntryRead() {
        let entry = gCurrentView.selectedEntry;
        if (entry) {
            let newState = !gCurrentView.getEntryView(entry).read;
            Commands.markEntryRead(entry, newState);
        }
    },

    markEntryRead: function cmd_markEntryRead(aEntry, aNewState) {
        API.query.markEntriesRead(aEntry, aNewState);
    },

    deleteOrRestoreSelectedEntry: function cmd_deleteOrRestoreSelectedEntry() {
        if (gCurrentView.selectedEntry) {
            if (gCurrentView.query.deleted === 'trashed')
                Commands.restoreEntry(gCurrentView.selectedEntry);
            else
                Commands.deleteEntry(gCurrentView.selectedEntry);
        }
    },

    deleteEntry: function cmd_deleteEntry(aEntry) {
        API.query.deleteEntries(aEntry, 'trashed');
    },

    restoreEntry: function cmd_restoreEntry(aEntry) {
        API.query.deleteEntries(aEntry, false);
    },

    toggleSelectedEntryStarred: function cmd_toggleSelectedEntryStarred() {
        let entry = gCurrentView.selectedEntry;
        if (entry) {
            let newState = !gCurrentView.getEntryView(entry).starred;
            Commands.starEntry(entry, newState);
        }
    },

    starEntry: function cmd_starEntry(aEntry, aNewState) {
        API.query.bookmarkEntries(aEntry, aNewState);
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

        let baseURI = Services.io.newURI(API.getFeed(entryView.feedID).feedURL);
        let linkURI = Services.io.newURI(entryView.entryURL, null, baseURI);

        Commands.openLink(linkURI.spec);

        if (!entryView.read)
            API.query.markEntriesRead(aEntry, true);
    },

    openLink: function cmd_openLink(aURL) {
        let docURI = Services.io.newURI(document.documentURI);
        getTopWindow().gBrowser.loadOneTab(aURL, docURI);
    },


    showFeedProperties: function cmd_showFeedProperties(aFeed) {
        let feed = aFeed ? aFeed : FeedList.selectedFeed;
        openDialog('chrome://brief/content/options/feed-properties.xul', 'FeedProperties',
                   'chrome,titlebar,toolbar,centerscreen,modal', feed.feedID);
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

    updateFeed: function cmd_updateFeed(aFeed) {
        let feed = aFeed ? aFeed : FeedList.selectedFeed;
        API.updateFeeds([feed.feedID]);
    },

}

function refreshProgressmeter() {
    let {status, scheduled, completed} = API.getUpdateServiceStatus();
    if (status != /* FeedUpdateService.NOT_UPDATING */ 0) { // XXX
        getElement('sidebar-top').dataset.mode = "update";

        if (scheduled > 1)
            getElement('update-progress').setAttribute('show', true);

        getElement('update-progress').value = 1.0 * completed / scheduled;
    }
    else {
        getElement('sidebar-top').dataset.mode = "idle";
        getElement('update-progress').removeAttribute('show');
    }
}


function onSearchbarCommand() {
    let searchbar = getElement('searchbar');

    if (searchbar.value)
        gCurrentView.titleOverride = STRINGS.formatStringFromName('searchResults', [searchbar.value], 1);
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

        // Special case: not Brief-specific
        this._general = Services.prefs.getBranch('general.');
        PrefCache.smoothScroll = this._general.getBoolPref('smoothScroll');
        this._general.addObserver('general', this, false);
    },

    unregister: function PrefObserver_unregister() {
        Prefs.removeObserver('', this);
    },

    // Hash table of prefs which are cached and available as properties
    // of PrefCache.
    _cachedPrefs: {
        doubleClickMarks:          'feedview.doubleClickMarks',
        autoMarkRead:              'feedview.autoMarkRead',
        sortUnreadViewOldestFirst: 'feedview.sortUnreadViewOldestFirst',
        showFavicons:              'showFavicons',
        homeFolder:                'homeFolder',
        pagePersist:               'pagePersist',
        assumeStandardKeys:        'assumeStandardKeys',
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
        if(aData === 'smoothScroll')
            PrefCache.smoothScroll = this._general.getBoolPref('general.smoothScroll');

        switch (aData) {
            case 'feedview.autoMarkRead':
                gCurrentView._autoMarkRead();
                break;

            case 'feedview.sortUnreadViewOldestFirst':
                if (gCurrentView.query.read === false)
                    gCurrentView.refresh();
                break;
        }
    }

};

/* Supports draggable splitters */
let SplitterModule = {
    _active: null,

    init: function Splitter_init() {
        document.body.addEventListener('mousedown', event => this._trigger(event), {capture: true});
        document.body.addEventListener('mousemove', event => this._update(event), {capture: true});
        document.body.addEventListener('mouseup', event => this._finish(event), {capture: true});
    },

    _trigger: function Splitter__trigger(event) {
        let splitter = event.target;
        if(splitter.nodeName !== 'draggable-splitter')
            return;
        if(event.button !== 0)
            return;
        if(event.detail === 2) {
            event.target.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
            // Looks like a double-click which are not handled automatically
        }
        splitter.parentNode.classList.add('resize-in-progress');
        let target = splitter.previousElementSibling;
        let offset = event.screenX - target.getBoundingClientRect().right;
        this._active = {splitter, target, offset};
        event.preventDefault();
    },

    _update: function Splitter__update(event) {
        if(this._active === null)
            return;
        let {splitter, target, offset} = this._active;
        let current_offset = event.screenX - target.getBoundingClientRect().right;
        target.style.width = (target.offsetWidth + (current_offset - offset)) + 'px';
        event.preventDefault();
    },

    _finish: function Splitter__finish(event) {
        if(this._active === null)
            return;
        let {splitter} = this._active;
        this._update(event);
        splitter.parentNode.classList.remove('resize-in-progress');
        this._active = null;
    },
};

let Persistence = {
    BRIEF_XUL_URL: 'chrome://brief/content/brief.xul',

    data: null,

    init: function Persistence_init() {
        let data = PrefCache.pagePersist;
        if(data !== "") {
            this.data = JSON.parse(data);
        } else {
            this.data = this._import();
            this.save();
        }
    },

    save: function Persistence_save() {
        this._collect();
        API.savePersistence(this.data);
    },

    _collect: function Persistence__collect() {
        let id = ViewList.selectedItem && ViewList.selectedItem.id;
        if(id === 'today-folder' || id === 'all-items-folder')
            this.data.startView = id;

        FeedList.persistFolderState();
        this.data.closedFolders = getElement('feed-list').getAttribute('closedFolders');

        this.data.tagList.width = getElement('tag-list').style.width;
        this.data.sidebar.width = getElement('sidebar').style.width;
        this.data.sidebar.hidden = !document.body.classList.contains('sidebar');
    },

    _import: function Persistence__import() {
        let store = Cc["@mozilla.org/xul/xulstore;1"].getService(Ci.nsIXULStore);
        return {
            startView: store.getValue(this.BRIEF_XUL_URL, "view-list", "startview"),
            closedFolders: store.getValue(this.BRIEF_XUL_URL, "feed-list", "closedFolders"),
            tagList: {
                width: store.getValue(this.BRIEF_XUL_URL, "tag-list", "width") + 'px'
            },
            sidebar: {
                width: store.getValue(this.BRIEF_XUL_URL, "sidebar", "width") + 'px',
                hidden: store.getValue(this.BRIEF_XUL_URL, "sidebar", "hidden")
            },
            view: {
                filter: Prefs.getBoolPref('feedview.filterUnread') ? 'unread' :
                    (Prefs.getBoolPref('feedview.filterStarred') ? 'starred' : 'all'),
                mode: Prefs.getIntPref('feedview.mode') ? 'headlines' : 'full',
            },
        }
    },
};

let Shortcuts = {
    init: function Shortcuts_init() {
        document.addEventListener('keypress', this, {capture: true});
        getElement('feed-view').contentDocument.addEventListener('keypress', this, {capture: true});
    },

    handleEvent: function Shortcuts_handleEvents(event) {
        let target = event.target;
        if(target.nodeName === 'input' || target.nodeName === 'textarea')
            return;
        let description = (
            (event.ctrlKey ? 'Ctrl+' : '') +
            (event.metaKey ? 'Meta+' : '') +
            (event.altKey ? 'Alt+' : '') +
            (event.shiftKey ? 'Shift+' : '') +
            event.key
        );
        switch(description) {
            case 'j': gCurrentView.selectNextEntry(); break;
            case 'k': gCurrentView.selectPrevEntry(); break;
            case 'u': gCurrentView.scrollDownByScreen(); break;
            case 'i': gCurrentView.scrollUpByScreen(); break;

            case 'm': Commands.toggleSelectedEntryRead(); break;
            case 'n': Commands.markVisibleEntriesRead(); break;
            case 'Alt+n': Commands.markViewRead(); break;
            case 't': Commands.deleteOrRestoreSelectedEntry(); break;
            case 'b': Commands.toggleSelectedEntryStarred(); break;
            case 'h': Commands.toggleSelectedEntryCollapsed(); break;
            case 'Enter': Commands.openSelectedEntryLink(); break;

            case 'f': Commands.switchViewMode(1); break;
            case 'g': Commands.switchViewMode(0); break;
            case 'a': Commands.switchViewFilter('all'); break;
            case 's': Commands.switchViewFilter('starred'); break;
            case 'd': Commands.switchViewFilter('unread'); break;
            case '/': getElement('searchbar').focus(); break;

            case 'Shift+?': Commands.displayShortcuts(); break;

            // Space and Shift+Space behave differently only in full view
            case ' ':
            case 'Shift+ ':
                if(!PrefCache.assumeStandardKeys || gCurrentView.headlinesView)
                    return;
                if(event.shiftKey)
                    gCurrentView.selectPrevEntry();
                else
                    gCurrentView.selectNextEntry();
                break;
            default: return;
        }
        event.preventDefault();
        event.stopPropagation();
    },
};


// ------- Utility functions --------

function getElement(aId) { return document.getElementById(aId); }
