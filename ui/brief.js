import {Database} from "/modules/database.js";
import {fetchFeed} from "/modules/feed-fetcher.js";
import {apply_i18n} from "/modules/i18n.js";
import {Prefs} from "/modules/prefs.js";
import {
    Comm, expectedEvent, wait, debounced, openBackgroundTab, getElement
} from "/modules/utils.js";
import {
    FeedList, ViewList, TagList, DropdownMenus,
    ViewListContextMenu, TagListContextMenu, FeedListContextMenu,
    ContextMenuModule,
    gCurrentView, setCurrentView
} from "./feedlist.js";
import {FeedView} from "./feedview.js";


async function init() {
    apply_i18n(document);

    let previewURL = new URLSearchParams(document.location.search).get("preview");
    let feedview_doc = await fetch('feedview.html');
    let contentIframe = getElement('feed-view');
    contentIframe.setAttribute('srcdoc', await feedview_doc.text());
    await expectedEvent(contentIframe, 'load');

    // Restore local persistence
    await Prefs.init();
    await Persistence.init();
    getElement('feed-list').setAttribute("closedFolders", Persistence.data.closedFolders);
    getElement('tag-list').style.width = Persistence.data.tagList.width;
    getElement('sidebar').style.width = Persistence.data.sidebar.width;
    document.body.classList.toggle('sidebar', !Persistence.data.sidebar.hidden);

    // Allow first meaningful paint
    if(previewURL !== null) {
        document.body.classList.add("preview");
    }
    document.body.classList.remove("loading");

    PrefObserver.init();

    await Database.init();

    Commands.switchViewFilter(Persistence.data.view.filter);

    Comm.registerObservers({
        'update-status': msg => refreshProgressmeter(msg),
    });
    Comm.broadcast('update-query-status');

    let refreshView = debounced(100, () => ViewList.refresh());
    Comm.registerObservers({
        'feedlist-updated': ({feeds}) => {
            refreshView();
            FeedList.rebuild(feeds);
        },
        'entries-updated': ({feeds}) => {
            refreshView();
            FeedList.refreshFeedTreeitems(feeds);
            //TODO: taglist refresh
        },
        'style-updated': () => {
            Commands.applyStyle();
        },
    });
    // TODO: should update FeedView and feed view title too(?) on title change
    // TODO: loading/error indicators

    Commands.applyStyle();

    let doc = contentIframe.contentDocument;
    doc.documentElement.setAttribute('lang', navigator.language);

    ViewList.init();
    FeedList.init();
    TagList.init();

    SplitterModule.init();
    document.getElementById('sidebar-splitter').addEventListener(
        'dblclick', () => Commands.hideSidebar());
    document.getElementById('reveal-sidebar-button').addEventListener(
        'click', () => Commands.revealSidebar());

    ContextMenuModule.init();

    ViewListContextMenu.build();
    TagListContextMenu.build();
    FeedListContextMenu.build();
    DropdownMenus.build();

    FeedViewHeader.init();

    Shortcuts.init();

    // Initialize event handlers
    document.getElementById('update-button').addEventListener(
        'click', () => Comm.broadcast('update-all'), {passive: true});
    document.getElementById('stop-updating-button').addEventListener(
        'click', () => Comm.broadcast('update-stop'), {passive: true});
    document.getElementById('organize-button').addEventListener(
        'click', () => FeedList.organize(), {passive: true});
    document.getElementById('subscribe-button').addEventListener(
        'click', () => Database.addFeeds({url: previewURL}), {passive: true});

    if(previewURL === null) {
        ViewList.selectedItem = getElement(Persistence.data.startView || 'all-items-folder');
    } else {
        let parsedFeed = await fetchFeed(previewURL);
        let feed = Object.assign({}, {
            feedID: "PREVIEW",
            feedURL: previewURL,
            title: parsedFeed.title,
            websiteURL: parsedFeed.link ? parsedFeed.link.href : '',
            subtitle: parsedFeed.subtitle ? parsedFeed.subtitle.text : '',
            language: parsedFeed.language,
            //FIXME: favicon missing
        });
        let entries = Database._feedToEntries({
            feed,
            parsedFeed,
            now: Date.now(),
        });
        entries.reverse();
        entries = entries.map(e => Database._entryFromItem(e));
        for(let [i, e] of entries.entries()) {
            e.id = i;
        }

        setCurrentView(new FeedView({
            title: parsedFeed.title,
            feeds: [feed],
            entries,
            filter: 'all',
            mode: 'full',
        }));
    }
    await wait();
    FeedList.rebuild();
}


export let Commands = {

    hideSidebar: function cmd_hideSidebar() {
        document.body.classList.remove('sidebar');
        Persistence.save(); // TODO: fix in a more clean way
    },

    revealSidebar: function cmd_revealSidebar() {
        document.body.classList.add('sidebar');
        Persistence.save(); // TODO: fix in a more clean way
    },

    markViewRead: function cmd_markViewRead() {
        Database.query(gCurrentView.query).markRead(true);
    },

    markVisibleEntriesRead: function cmd_markVisibleEntriesRead() {
        gCurrentView.markVisibleEntriesRead();
    },

    switchViewMode: function cmd_switchViewMode(aMode) {
        if (FeedList.selectedFeed) {
            Database.modifyFeed({
                feedID: FeedList.selectedFeed.feedID,
                viewMode: (aMode === 'headlines')
            });
            // Refresh will happen from the observer
        } else {
            Persistence.data.view.mode = aMode;
            Persistence.save();
            if(gCurrentView !== undefined) {
                gCurrentView.setDefaultViewMode(aMode);
            }
        }

    },

    switchViewFilter: function cmd_switchViewFilter(aFilter) {
        if(aFilter !== Persistence.data.view.filter) {
            Persistence.data.view.filter = aFilter;
            Persistence.save();
        }

        getElement('show-all-entries-checkbox').dataset.checked = (aFilter === 'all');
        getElement('filter-unread-checkbox').dataset.checked = (aFilter === 'unread');
        getElement('filter-starred-checkbox').dataset.checked = (aFilter === 'starred');

        if(gCurrentView !== undefined) {
            gCurrentView.setFilter(aFilter);
        }
    },

    openFeedWebsite: function cmd_openWebsite(aFeed) {
        let feed = aFeed ? aFeed : FeedList.selectedFeed;
        let url = feed.websiteURL || (new URL(feed.feedURL).origin);
        openBackgroundTab(url);
    },

    emptyFeed: function cmd_emptyFeed(aFeed) {
        let feed = aFeed ? aFeed : FeedList.selectedFeed;
        let query = {
            deleted: false,
            starred: false,
            feeds: [feed.feedID]
        };
        Database.query(query).markDeleted('trashed');
    },

    deleteFeed: function cmd_deleteFeed(aFeed) {
        let feed = aFeed ? aFeed : FeedList.selectedFeed;
        let text = browser.i18n.getMessage('confirmFeedDeletionText', feed.title);

        if (window.confirm(text)) {
            Database.deleteFeed(feed);
        }
    },

    restoreTrashed: function cmd_restoreTrashed() {
        ViewList.getQueryForView('trash-folder');
        Database.query(ViewList.getQueryForView('trash-folder')).markDeleted(false);
    },

    emptyTrash: function cmd_emptyTrash() {
        Database.query(ViewList.getQueryForView('trash-folder')).markDeleted('deleted');
    },

    toggleSelectedEntryRead: function cmd_toggleSelectedEntryRead() {
        let entry = gCurrentView.selectedEntry;
        if (entry) {
            let newState = !gCurrentView.getEntryView(entry).read;
            Commands.markEntryRead(entry, newState);
        }
    },

    markEntryRead: function cmd_markEntryRead(aEntry, aNewState) {
        gCurrentView.getEntryView(aEntry).markEntryRead(aNewState);
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
        gCurrentView.getEntryView(aEntry).deleteEntry();
    },

    restoreEntry: function cmd_restoreEntry(aEntry) {
        gCurrentView.getEntryView(aEntry).restoreEntry();
    },

    toggleSelectedEntryStarred: function cmd_toggleSelectedEntryStarred() {
        let entry = gCurrentView.selectedEntry;
        if (entry) {
            let newState = !gCurrentView.getEntryView(entry).starred;
            Commands.starEntry(entry, newState);
        }
    },

    starEntry: function cmd_starEntry(aEntry, aNewState) {
        Database.query(aEntry).bookmark(aNewState);
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
        gCurrentView.getEntryView(aEntry).openEntryLink();
    },

    showFeedProperties: function cmd_showFeedProperties(aFeed) {
        let feed = aFeed ? aFeed : FeedList.selectedFeed;

        browser.windows.create({
            url: `/ui/options/feed-properties.xhtml?feedID=${feed.feedID}`,
            type: 'popup',
            width: 400,
            height: 300,
        });
    },

    displayShortcuts: async function cmd_displayShortcuts() {
        let windows = await browser.windows.getAll({windowTypes: ['popup']});
        // Compat: fixed in Firefox 58
        windows = windows.filter(w => w.type === 'popup' && w.title.includes("Brief"));
        if(windows.length > 0) {
            browser.windows.update(windows[0].id, {focused: true});
        } else {
            browser.windows.create({
                url: '/ui/keyboard-shortcuts.xhtml',
                type: 'popup',
                width: 500,
                height: Math.min(window.screen.availHeight, 650),
            });
        }
    },

    async applyStyle() {
        let {custom_css: style} = await browser.storage.local.get({'custom_css': ''});
        let blob = new Blob([style], {type: 'text/css'});
        let url = URL.createObjectURL(blob);
        document.getElementById('custom-css').href = url;
        let content = document.getElementById('feed-view').contentDocument;
        content.getElementById('custom-css').href = url;
    },
};

async function refreshProgressmeter({active, progress}) {
    getElement('update-progress').value = progress;
    if (active) {
        getElement('sidebar-top').dataset.mode = "update";
        getElement('update-progress').setAttribute('show', true); //TODO: css?
    }
    else {
        getElement('sidebar-top').dataset.mode = "idle";
        getElement('update-progress').removeAttribute('show');
    }
}

let Searchbar = {
    init() {
        let searchbar = getElement('searchbar');
        searchbar.addEventListener('input', () => this.onInput());
        searchbar.addEventListener('blur', () => this.onBlur());
    },

    onInput() {
        let searchbar = getElement('searchbar');

        if (searchbar.value)
            gCurrentView.titleOverride = browser.i18n.getMessage('searchResults', searchbar.value);
        else
            gCurrentView.titleOverride = '';

        gCurrentView.query.searchString = searchbar.value;
        gCurrentView.refresh();
    },

    onBlur() {
        let searchbar = getElement('searchbar');
        if (!searchbar.value && gCurrentView.query.searchString) {
            gCurrentView.titleOverride = '';
            gCurrentView.query.searchString = searchbar.value;
            gCurrentView.refresh();
        }
    },
};

let FeedViewHeader = {
    init() {
        Searchbar.init();
        const handlers = {
            'mark-view-read': event => this.markRead(event),
            'headlines-checkbox': () => Commands.switchViewMode('headlines'),
            'full-view-checkbox': () => Commands.switchViewMode('full'),
            'show-all-entries-checkbox': () => Commands.switchViewFilter('all'),
            'filter-unread-checkbox': () => Commands.switchViewFilter('unread'),
            'filter-starred-checkbox': () => Commands.switchViewFilter('starred'),
        };

        for(let id in handlers) {
            document.getElementById(id).addEventListener('click', handlers[id]);
        }
    },

    markRead(event) {
        if (event.ctrlKey)
            Commands.markVisibleEntriesRead();
        else
            Commands.markViewRead();
    },
};


// Preferences observer.
let PrefObserver = {
    init() {
        Prefs.addObserver('feedview.autoMarkRead', () => gCurrentView._autoMarkRead());
        Prefs.addObserver('feedview.sortUnreadViewOldestFirst', () => {
            if (gCurrentView.query.read === false)
                gCurrentView.refresh();
        });
    },
};

/* Supports draggable splitters */
let SplitterModule = {
    _active: null,

    init: function Splitter_init() {
        document.body.addEventListener('mousedown', event => this._trigger(event), {capture: true});
    },

    _trigger: function Splitter__trigger(event) {
        let splitter = event.target;
        if(splitter.nodeName !== 'draggable-splitter')
            return;
        if(event.button !== 0)
            return;
        splitter.addEventListener('mousemove', this);
        splitter.addEventListener('mouseup', this);
        splitter.setCapture(); // Auto-released on mouseup
        let target = splitter.previousElementSibling;
        let offset = event.screenX - target.getBoundingClientRect().right;
        this._active = {splitter, target, offset};
        event.preventDefault();
        event.stopPropagation();
    },

    handleEvent: function Splitter_handleEvent(event) {
        if(this._active === null)
            return;
        let {splitter, target, offset} = this._active;
        switch (event.type) {
            case 'mouseup':
                splitter.removeEventListener('mousemove', this);
                splitter.removeEventListener('mouseup', this);
                this._active = null;
                // Fallthrough for the final update
            case 'mousemove':
                {
                    let current_offset = event.screenX - target.getBoundingClientRect().right;
                    target.style.width = (target.offsetWidth + (current_offset - offset)) + 'px';
                }
                break;
        }
        event.stopPropagation();
        if(event.type === 'mouseup') {
            Persistence.save(); // TODO: fix in a more clean way
        }
    },
};

export let Persistence = {
    data: null,

    init: async function Persistence_init() {
        let data = Prefs.get('pagePersist');
        if(data !== "") {
            this.data = JSON.parse(data);
        } else {
            this.data = {
                startView: 'today-folder',
                closedFolders: '_',
                tagList: {width: '200px'},
                sidebar: {width: '400px', hidden: false},
                view: {mode: 'full', filter: 'all'},
            };
            this.save();
        }
        window.addEventListener('beforeunload', () => this.save(), {once: true, passive: true});
    },

    save: function Persistence_save() {
        this._collect();
        Prefs.set('pagePersist', JSON.stringify(this.data));
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
};

export let Shortcuts = {
    mode: 'command',

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
        if(this.mode === 'organize') {
            if(description.includes('Enter')) {
                event.preventDefault();
                event.stopPropagation();
                document.activeElement.blur();
            }
            if(description.includes('Escape')) {
                event.preventDefault();
                event.stopPropagation();
                FeedList.rebuild();
            }
            return;
        }
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

            case 'f': Commands.switchViewMode('full'); break;
            case 'g': Commands.switchViewMode('headlines'); break;
            case 'a': Commands.switchViewFilter('all'); break;
            case 's': Commands.switchViewFilter('starred'); break;
            case 'd': Commands.switchViewFilter('unread'); break;
            case '/': getElement('searchbar').focus(); break;

            case 'Shift+?': Commands.displayShortcuts(); break;

            // Space and Shift+Space behave differently only in full view
            case ' ':
            case 'Shift+ ':
                if(!Prefs.get('assumeStandardKeys') || gCurrentView.headlinesView)
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


// ===== Init =====
// ES6 modules are executed after DOM parsing is complete by default
init();

// Debugging hooks
window.Comm = Comm;
window.Database = Database;
window.Prefs = Prefs;
