// Minimal number of window heights worth of entries loaded ahead of the
// current scrolling position at any given time.
const MIN_LOADED_WINDOW_HEIGHTS = 1;

// Number of window heights worth of entries to load when the above threshold is crossed.
const WINDOW_HEIGHTS_LOAD = 2;

// Number of entries queried in each incremental step until they fill the defined height.
const LOAD_STEP_SIZE = 5;


__defineGetter__("gSecurityManager", function() {
    delete this.gSecurityManager;
    return this.gSecurityManager = Cc['@mozilla.org/scriptsecuritymanager;1'].
                                   getService(Ci.nsIScriptSecurityManager);
});

__defineGetter__("gBriefPrincipal", function() {
    var ioService = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
    var uri = ioService.newURI(document.documentURI, null, null)
    var resolvedURI = Cc['@mozilla.org/chrome/chrome-registry;1'].
                      getService(Ci.nsIChromeRegistry).
                      convertChromeURL(uri);

    delete this.gBriefPrincipal;
    return this.gBriefPrincipal = gSecurityManager.getCodebasePrincipal(resolvedURI);
});


/**
 * The instance of FeedView currently attached to the browser.
 */
var gFeedView = null;

/**
 * This object represents the main feed display. It stores and manages display parameters.
 * The feed is displayed using a local, unprivileged template page. We insert third-party
 * content in it (entries are served with full HTML markup), so the template page has to
 * be untrusted and we respect XPCNativeWrappers when interacting with it.
 * Individual entries are inserted dynamically. Their structure and behaviour is defined
 * by an XBL binding.
 *
 * @param aTitle  Title of the view which will be shown in the header.
 * @param aQuery  Query which selects contained entries.
 * @param aUnreadFixed  Indicates that the "unread" query parameter is fixed and the view
 *                      affected by feedview.filterUnread pref.
 * @param aStarredFixed  Indicates that the "starred" query parameter is fixed and the
 *                       view affected by feedview.filterStarred pref.
 */
function FeedView(aTitle, aQuery, aUnreadFixed, aStarredFixed) {
    this.title = aTitle;
    this.query = aQuery;
    this.unreadParamFixed = aUnreadFixed;
    this.starredParamFixed = aStarredFixed;
    this.query.sortOrder = Ci.nsIBriefQuery.SORT_BY_DATE;
    this.entriesMarkedUnread = [];
}


FeedView.prototype = {

    // Used to temporarily override the title. It used for searching,
    // when the search string is displayed in place of the title.
    titleOverride: '',

    unreadParamFixed: false,
    starredParamFixed: false,

    get browser FeedView_browser() {
        delete this.__proto__.browser;
        return this.__proto__.browser = getElement('feed-view');
    },

    get document FeedView_document() {
        return this.browser.contentDocument;
    },

    get window FeedView_window() {
        return this.document.defaultView;
    },

    get feedContent FeedView_feedContent() {
        return this.document.getElementById('feed-content');
    },


    // Query that selects all entries contained by the view.
    set query FeedView_query_set(aQuery) {
        return this.__query = aQuery;
    },

    get query FeedView_query_get() {
        if (!this.unreadParamFixed)
            this.__query.unread = gPrefs.filterUnread;
        if (!this.starredParamFixed)
            this.__query.starred = gPrefs.filterStarred;

        if (this.__query.unread && gPrefs.sortUnreadViewOldestFirst)
            this.__query.sortDirection = Ci.nsIBriefQuery.SORT_ASCENDING;
        else
            this.__query.sortDirection = Ci.nsIBriefQuery.SORT_DESCENDING;

        return this.__query;
    },

    // Returns a copy of the query that selects all entries contained by the view.
    // Use this function when you want to modify the query before using it, without
    // permanently changing the view parameters.
    getQuery: function FeedView_getQuery() {
        var query = this.query;
        var copy = new Query();
        for (property in query)
            copy[property] = query[property];
        return copy;
    },

    // It's much faster to retrieve entries by their IDs when possible,
    // we keep a separate query for that.
    _getFastQuery: function FeedView_getFastQuery(aEntries) {
        if (!this.__fastQuery)
            this.__fastQuery = new Query();

        this.__fastQuery.sortOrder = this.query.sortOrder;
        this.__fastQuery.sortDirection = this.query.sortDirection;
        this.__fastQuery.entries = aEntries;
        return this.__fastQuery;
    },


    // Ordered array of IDs of all entries that the view contains.
    get _entries FeedView__entries_get() {
        if (!this.__entries)
            this.__entries = this.query.getEntries();
        return this.__entries
    },

    set _entries FeedView__entries_set(aEntries) {
        this.__entries = aEntries;
    },

    // Ordered array of IDs of entries that have been loaded.
    _loadedEntries: [],

    get entryCount Feedview_entryCount() {
        return this._entries.length;
    },

    // Indicates whether the feed view is currently displayed in the browser.
    get active FeedView_active() {
        return (this.browser.currentURI.equals(gTemplateURI) && gFeedView == this);
    },


    collapseEntry: function FeedView_collapseEntry(aEntry, aNewState, aAnimate) {
        var eventType = aAnimate ? 'DoCollapseEntryAnimated' : 'DoCollapseEntry';
        this._sendEvent(aEntry, eventType, aNewState);

        if (aEntry == this.selectedEntry) {
            async(function() {
                alignWithTop = (this.selectedElement.offsetHeight > this.window.innerHeight);
                this.selectedElement.scrollIntoView(alignWithTop);
            }, 310, this);
        }
    },


    /**
     * Sends an event to an entry element, for example a message to perform an action
     * or update its state.
     * This is the only way we can communicate with the untrusted document.
     *
     * @param aTargetEntries Array of IDs of target entries.
     * @param aEventType     Type of the event.
     * @param aState         Additional parameter, the new state of the entry.
     */
    _sendEvent: function FeedView__sendEvent(aTargetEntries, aEventType, aState) {
        var targetEntries = aTargetEntries.splice ? aTargetEntries : [aTargetEntries];

        for (let i = 0; i < targetEntries.length; i++) {
            let evt = document.createEvent('Events');
            evt.initEvent('ViewEvent', false, false);

            let element = this.document.getElementById(targetEntries[i]);
            element.setAttribute('eventType', aEventType);
            element.setAttribute('eventState', aState);

            element.dispatchEvent(evt);
        }
    },

    _getAnonElement: function FeedView__getAnonElement(aRoot, aAttrVal) {
        return this.document.getAnonymousElementByAttribute(aRoot, 'class', aAttrVal);
    },

    // ID of the selected entry.
    selectedEntry: null,

    get selectedElement FeedView_selectedElement() {
        return this.selectedEntry ? this.document.getElementById(this.selectedEntry)
                                  : null;
    },


    // Indicates that the next scroll event will be ignored.
    _ignoreScrollEvent: false,

    selectNextEntry: function FeedView_selectNextEntry() {
        if (this._scrolling)
            return;

        if (gPrefs.entrySelectionEnabled) {
            var entryElement = this.selectedElement.nextSibling;
            if (entryElement)
                this.selectEntry(parseInt(entryElement.id), true, true);
        }
        else {
            gPrefBranch.setBoolPref('feedview.entrySelectionEnabled', true);
        }
    },

    selectPrevEntry: function FeedView_selectPrevEntry() {
        if (this._scrolling)
            return;

        if (gPrefs.entrySelectionEnabled) {
            var entryElement = this.selectedElement.previousSibling;
            if (entryElement)
                this.selectEntry(parseInt(entryElement.id), true, true);
        }
        else {
            gPrefBranch.setBoolPref('feedview.entrySelectionEnabled', true);
        }
    },

    /**
     * Selects the given entry and optionally scrolls it into view.
     *
     * @param aEntry           ID or DOM element of entry to select. Pass null to
     *                         deselect current entry.
     * @param aScroll          Set to TRUE to scroll the entry into view.
     * @param aScrollSmoothly  Set to TRUE to scroll smoothly, FALSE to jump directly
     *                         to the target position.
     */
    selectEntry: function FeedView_selectEntry(aEntry, aScroll, aScrollSmoothly) {
        if (!this.active)
            return;

        var entry = (typeof aEntry == 'number' || !aEntry) ? aEntry
                                                           : parseInt(aEntry.id);

        if (this.selectedElement)
            this.selectedElement.removeAttribute('selected');

        this.selectedEntry = entry;

        if (entry) {
            this.selectedElement.setAttribute('selected', true);

            if (aScroll)
                this.scrollToEntry(entry, aScrollSmoothly);
        }
    },

    /**
     * Scrolls to the entry before the entry closest to the middle of the screen.
     *
     * @param aSmooth Set to TRUE to scroll smoothly, FALSE to jump directly to the
     *                target position.
     */
    scrollToPrevEntry: function FeedView_scrollToPrevEntry(aSmooth) {
        var middleElement = this._getMiddleEntryElement();
        if (middleElement)
            var previousElement = middleElement.previousSibling;

        if (previousElement)
            this.scrollToEntry(parseInt(previousElement.id), aSmooth);
    },


    // See scrollToPrevEntry.
    scrollToNextEntry: function FeedView_scrollToNextEntry(aSmooth) {
        var middleElement = this._getMiddleEntryElement();
        if (middleElement)
            var nextElement = middleElement.nextSibling;

        if (nextElement)
            this.scrollToEntry(parseInt(nextElement.id), aSmooth);
    },


    /**
     * Scroll entry into view. If the entry is taller than the height of the screen,
     * the scroll position is aligned with the top of the entry, otherwise the entry
     * is positioned in the middle of the screen.
     *
     * @param aEntry  ID of entry to scroll to.
     * @param aSmooth Set to TRUE to scroll smoothly, FALSE to jump directly to the
     *                target position.
     */
    scrollToEntry: function FeedView_scrollToEntry(aEntry, aSmooth) {
        var win = this.window;
        var entryElement = this.document.getElementById(aEntry);

        if (entryElement.offsetHeight >= win.innerHeight) {
            var targetPosition = entryElement.offsetTop;
        }
        else {
            var difference = win.innerHeight - entryElement.offsetHeight;
            targetPosition = entryElement.offsetTop - Math.floor(difference / 2);
        }

        targetPosition = Math.max(targetPosition, 0);
        targetPosition = Math.min(targetPosition, win.scrollMaxY);

        if (targetPosition != win.pageYOffset) {
            if (aSmooth)
                this._scrollSmoothly(targetPosition);
            else
                win.scroll(win.pageXOffset, targetPosition);
        }
    },

    // Indicates the smooth scrolling is in progress and by the way stores the
    // ID of the scrolling interval.
    _scrolling: null,

    _scrollSmoothly: function FeedView__scrollSmoothly(aTargetPosition) {
        if (this._scrolling)
            return;

        var win = this.window;

        var distance = aTargetPosition - win.pageYOffset;
        with (Math) {
            var jumpCount = exp(abs(distance) / 400) + 6;
            jumpCount = max(jumpCount, 7);
            jumpCount = min(jumpCount, 15);

            var jump = round(distance / jumpCount);
        }

        var self = this;

        function scroll() {
            // If we are within epsilon smaller or equal to the jump,
            // then scroll directly to the target position.
            if (Math.abs(aTargetPosition - win.pageYOffset) <= Math.abs(jump)) {
                win.scroll(win.pageXOffset, aTargetPosition)
                self._stopSmoothScrolling();

                // One more scroll event will be sent but _scrolling is already null,
                // so the event handler will try to automatically select the central
                // entry. This has to be prevented, because it may deselect the entry
                // that the user has just selected manually.
                self._ignoreScrollEvent = true;
            }
            else {
                win.scroll(win.pageXOffset, win.pageYOffset + jump);
            }
        }

        this._scrolling = setInterval(scroll, 10);
    },

    _stopSmoothScrolling: function FeedView__stopSmoothScrolling() {
        clearInterval(this._scrolling);
        this._scrolling = null;
    },

    // Return the entry element closest to the middle of the screen.
    _getMiddleEntryElement: function FeedView__getMiddleEntryElement() {
        var elems = this.feedContent.childNodes;
        if (!elems.length)
            return null;

        var middleLine = this.window.pageYOffset + Math.round(this.window.innerHeight / 2);

        // Get the element in the middle of the screen.
        for (let i = elems.length - 1; i >= 0; i--) {
            if ((elems[i].offsetTop <= middleLine)
                && (!elems[i + 1] || elems[i + 1].offsetTop > middleLine)) {
                var middleElement = elems[i];
                break;
            }
        }

        return middleElement || elems[elems.length - 1];
    },

    // This array stores the list of entries marked as unread by the user. They become
    // excluded from auto-marking, in order to prevent them from being immediately
    // re-marked as read when autoMarkRead is on.
    entriesMarkedUnread: [],

    _markVisibleTimeout: null,

    _markVisibleAsRead: function FeedView__markVisibleAsRead() {
        if (gPrefs.autoMarkRead && !gPrefs.showHeadlinesOnly && !this.query.unread) {
            clearTimeout(this._markVisibleTimeout);
            this._markVisibleTimeout = async(this._doMarkVisibleAsRead, 1000, this);
        }
    },

    _doMarkVisibleAsRead: function FeedView__doMarkVisibleAsRead() {
        var win = this.window;
        var winTop = win.pageYOffset;
        var winBottom = winTop + win.innerHeight;
        var entries = this.feedContent.childNodes;

        var entriesToMark = [];

        for (let i = 0; i < entries.length; i++) {
            let entryTop = entries[i].offsetTop;
            let id = parseInt(entries[i].id);
            let wasMarkedUnread = (this.entriesMarkedUnread.indexOf(id) != -1);

            if ((entryTop >= winTop) && (entryTop < winBottom - 50) && !wasMarkedUnread)
                entriesToMark.push(id);
        }

        if (entriesToMark.length) {
            var query = new QuerySH(entriesToMark);
            query.markEntriesRead(true);
        }
    },

    _toggleHeadlinesView: function FeedView__toggleHeadlinesView() {
        for (let i = 0; i < this._loadedEntries.length; i++)
            this.collapseEntry(this._loadedEntries[i], gPrefs.showHeadlinesOnly, false);

        if (gPrefs.showHeadlinesOnly) {
            this.feedContent.setAttribute('showHeadlinesOnly', true);
            this._loadEntries();
        }
        else {
            this.feedContent.removeAttribute('showHeadlinesOnly');
            this._markVisibleAsRead();
        }
    },


    /**
     * Displays the view, adds it as the listener for events in the template page,
     * and sets it as the currently attached instance - under gFeedView.
     */
    attach: function FeedView_attach() {
        if (gFeedView)
            gFeedView.detach();
        else
            var noExistingView = true;

        // Clear the searchbar.
        var searchbar = getElement('searchbar');
        if (!this.query.searchString && searchbar.searchInProgress) {
            searchbar.searchInProgress = false;
            searchbar.clear();
        }

        // Disable filters for views with fixed parameters.
        getElement('filter-unread-checkbox').disabled = this.unreadParamFixed;
        getElement('filter-starred-checkbox').disabled = this.starredParamFixed;

        this.browser.addEventListener('load', this, false);
        gStorage.addObserver(this);

        // Load the template page if it isn't loaded yet. We also have to make sure to
        // load it at startup, when no view was attached yet, because the template page
        // may have been restored by SessionStore - before the custom CSS file was
        // registered as a resource and before any FeedView was attached.
        if (!this.browser.currentURI.equals(gTemplateURI) || noExistingView) {
            this.browser.loadURI(gTemplateURI.spec);
        }
        else {
            for each (event in this._events)
                this.document.addEventListener(event, this, true);

            // Refresh asynchronously, because UI maybe waiting to be redrawn
            // (e.g. after selecting a treeitem).
            async(this.refresh, 0, this);
        }

        gFeedView = this;
    },

    /**
     * Removes the view as the listener, cancels pending actions.
     */
    detach: function FeedView_detach() {
        this.browser.removeEventListener('load', this, false);
        this.window.removeEventListener('resize', this, false);
        for each (event in this._events)
            this.document.removeEventListener(event, this, true);

        gStorage.removeObserver(this);

        this._stopSmoothScrolling();
        clearTimeout(this._markVisibleTimeout);

        // Remove entries.
        var container = this.document.getElementById('container');
        container.removeChild(this.feedContent);
        var content = this.document.createElement('div');
        content.id = 'feed-content';
        container.appendChild(content);

        gFeedView = null;
    },


    // Events to which we listen in the template page. Entry binding communicates with
    // chrome to perform actions that require full privileges by sending custom events.
    _events: ['SwitchEntryRead', 'StarEntry', 'ShowBookmarkPopup', 'DeleteEntry',
              'RestoreEntry', 'EntryUncollapsed', 'ShowBookmarkPanel', 'click',
              'mousedown', 'scroll', 'keypress'],

    handleEvent: function FeedView_handleEvent(aEvent) {
        var target = aEvent.target;
        var id = parseInt(target.id);

        // Checking if default action has been prevented helps Brief play nicely with
        // other extensions. In Gecko <1.9.2 getPreventDefault() is available only
        // for UI events.
        if (aEvent instanceof Ci.nsIDOMNSUIEvent && aEvent.getPreventDefault())
            return;

        switch (aEvent.type) {

            // Forward commands from the view to the controller.
            case 'SwitchEntryRead':
                gCommands.markEntryRead(id, !target.hasAttribute('read'));
                break;
            case 'DeleteEntry':
                gCommands.deleteEntry(id);
                break;
            case 'RestoreEntry':
                gCommands.restoreEntry(id);
                break;
            case 'StarEntry':
                gCommands.starEntry(id, true);
                break;

            case 'EntryUncollapsed':
                if (gPrefs.autoMarkRead && !this.query.unread)
                    gCommands.markEntryRead(id, true);
                break;

            case 'ShowBookmarkPanel':
                let query = new QuerySH([id]);
                query.verifyEntriesStarredStatus();
                let itemID = query.getProperty('bookmarkID')[0].bookmarkID;

                let starElem = this._getAnonElement(target.firstChild, 'article-star');
                getTopWindow().StarUI.showEditBookmarkPopup(itemID, starElem, 'after_start');
                break;

            // Set up the template page when it's loaded.
            case 'load':
                getElement('feed-view-header').hidden = !this.active;

                if (this.active) {
                    this.window.addEventListener('resize', this, false);
                    for each (event in this._events)
                        this.document.addEventListener(event, this, true);

                    // Pass some data which bindings need but don't have access to.
                    var data = {};
                    data.doubleClickMarks = gPrefs.doubleClickMarks;
                    data.markReadString = this.markAsReadStr;
                    data.markUnreadString = this.markAsUnreadStr;
                    this.window.wrappedJSObject.gData = data;
                    this.refresh();
                }
                break;

            case 'scroll':
                this._markVisibleAsRead();

                if (this._ignoreScrollEvent) {
                    this._ignoreScrollEvent = false;
                    break;
                }

                if (gPrefs.entrySelectionEnabled && !this._scrolling) {
                    clearTimeout(this._scrollSelectionTimeout);

                    function selectCentralEntry() {
                        let elem = this._getMiddleEntryElement();
                        this.selectEntry(elem);
                    }
                    this._scrollSelectionTimeout = async(selectCentralEntry, 100, this);
                }

                this._loadEntries();
                break;

            case 'resize':
                this._loadEntries();
                break;

            case 'click':
                this._onClick(aEvent);
                break;
            case 'keypress':
                onKeyPress(aEvent);
                break;
        }
    },

    // This event handler is responsible for selecting entries when clicked,
    // forcing opening links in new tabs depending on openEntriesInTabs pref,
    // and marking entries as read when opened.
    _onClick: function FeedView__onClick(aEvent) {
        // This loops walks the parent chain of the even target to check if the
        // article-container and/or an anchor were clicked.
        var elem = aEvent.target;
        while (elem != this.document.documentElement) {
            if (elem.localName.toUpperCase() == 'A')
                var anchor = elem;

            if (elem.className == 'article-container') {
                var entryElement = elem;
                break;
            }
            elem = elem.parentNode;
        }

        if (gPrefs.entrySelectionEnabled && entryElement)
            gFeedView.selectEntry(parseInt(entryElement.id));

        if (anchor && (aEvent.button == 0 || aEvent.button == 1)) {
            // preventDefault doesn't stop the default action for middle-clicks,
            // so we've got stop propagation as well.
            aEvent.preventDefault();
            if (aEvent.button == 1)
                aEvent.stopPropagation();

            var openInTabs = gPrefBranch.getBoolPref('feedview.openEntriesInTabs');
            var newTab = openInTabs || aEvent.button == 1 || aEvent.ctrlKey;

            if (anchor.className == 'article-title-link')
                gCommands.openEntryLink(entryElement, newTab);
            else if (anchor.hasAttribute('href'))
                gCommands.openLink(anchor.getAttribute('href'), newTab);
        }
    },

    // nsIBriefStorageObserver
    onEntriesAdded: function FeedView_onEntriesAdded(aEntryList) {
        if (this.active && this.entryCount < this.query.getEntryCount())
            this._onEntriesAdded(aEntryList.IDs);
    },

    // nsIBriefStorageObserver
    onEntriesUpdated: function FeedView_onEntriesUpdated(aEntryList) {
        if (this.active) {
            this._onEntriesRemoved(aEntryList.IDs, false, false);
            this._onEntriesAdded(aEntryList.IDs);
        }
    },

    // nsIBriefStorageObserver
    onEntriesMarkedRead: function FeedView_onEntriesMarkedRead(aEntryList, aNewState) {
        if (!this.active)
            return;

        if (this.query.unread) {
            let delta = this.query.getEntryCount() - this.entryCount;
            if (delta > 0)
                this._onEntriesAdded(aEntryList.IDs);
            else if (delta < 0)
                this._onEntriesRemoved(aEntryList.IDs, true, true);
        }

        var entries = intersect(this._loadedEntries, aEntryList.IDs);
        this._sendEvent(entries, 'EntryMarkedRead', aNewState);
    },

    // nsIBriefStorageObserver
    onEntriesStarred: function FeedView_onEntriesStarred(aEntryList, aNewState) {
        if (!this.active)
            return;

        if (this.query.starred) {
            let delta = this.query.getEntryCount() - this.entryCount;
            if (delta > 0)
                this._onEntriesAdded(aEntryList.IDs);
            else if (delta < 0)
                this._onEntriesRemoved(aEntryList.IDs, true, true);
        }

        var entries = intersect(this._loadedEntries, aEntryList.IDs);
        this._sendEvent(entries, 'EntryStarred', aNewState);
    },

    // nsIBriefStorageObserver
    onEntriesTagged: function FeedView_onEntriesTagged(aEntryList, aNewState, aTag) {
        if (!this.active)
            return;

        var entries = intersect(this._loadedEntries, aEntryList.IDs);
        for (let i = 0; i < entries.length; i++) {
            let elem = this.document.getElementById(entries[i]);
            if (elem) {
                elem.setAttribute('changedTag', aTag);
                this._sendEvent(id, 'EntryTagged', aNewState);
            }
        }

        if (this.query.tags && this.query.tags[0] === aTag) {
            let delta = this.query.getEntryCount() - this.entryCount;
            if (delta > 0)
                this._onEntriesAdded(aEntryList.IDs);
            else if (delta < 0)
                this._onEntriesRemoved(aEntryList.IDs, true, true);
        }
    },

    // nsIBriefStorageObserver
    onEntriesDeleted: function FeedView_onEntriesDeleted(aEntryList, aNewState) {
        if (!this.active)
            return;

        var delta = this.query.getEntryCount() - this.entryCount;
        if (delta > 0)
            this._onEntriesAdded(aEntryList.IDs);
        else if (delta < 0)
            this._onEntriesRemoved(aEntryList.IDs, true, true);
    },


    /**
     * Checks if given entries belong to the view and inserts them.
     * @param aNewEntries Array of entries to be checked.
     */
    _onEntriesAdded: function FeedView__onEntriesAdded(aNewEntries) {
        // We need to compare aNewEntries with the current list of entries that should
        // be loaded. However, if the previously loaded entries didn't fill the
        // window, there is no way to learn this current list, other than
        // incrementally loading more entries until they fill the window. It's not
        // worth the hassle here, let's just perform a full refresh.
        var win = this.window;
        if (win.scrollMaxY - win.pageYOffset < win.innerHeight * MIN_LOADED_WINDOW_HEIGHTS) {
            this.refresh()
            return;
        }

        // Get the current list of entries that should be loaded,
        // using the date of the last loaded entry as an anchor.
        var query = this.getQuery();
        query.startDate = parseInt(this.feedContent.lastChild.getAttribute('date'));
        this._loadedEntries = query.getEntries();

        function fun(entry) this._loadedEntries.indexOf(entry) != -1;
        var entriesToInsert = aNewEntries.filter(fun, this);

        if (!entriesToInsert.length)
            return;

        var fullEntries = this._getFastQuery(entriesToInsert).getFullEntries();
        for (let i = 0; i < fullEntries.length; i++) {
            let index = this._loadedEntries.indexOf(fullEntries[i].id);
            this._insertEntry(fullEntries[i], index);
        }

        this._setEmptyViewMessage();
        this._asyncRefreshEntryList();
    },

    /**
     * Checks if given entries are in the view and removes them.
     *
     * @param aRemovedEntries Array of entries to be checked.
     * @param aAnimate Use animation when a single entry is being removed.
     * @param aLoadNewEntries Load new entries to fill the screen.
     */
    _onEntriesRemoved: function FeedView__onEntriesRemoved(aRemovedEntries, aAnimate,
                                                           aLoadNewEntries) {
        this._entries = this._entries.filter(function(e) aRemovedEntries.indexOf(e) == -1);

        var indices = aRemovedEntries.map(function(e) this._loadedEntries.indexOf(e), this).
                                      filter(function(i) i != -1);
        if (!indices.length)
            return;

        // Removing content may cause a scroll event, which should be ignored.
        this._ignoreScrollEvent = true;
        getTopWindow().StarUI.panel.hidePopup();

        // Remember index of selected entry if it is removed.
        var selectedEntryIndex = -1;

        let self = this;
        function finish() {
            self.document.removeEventListener('EntryRemoved', finish, true);

            if (aLoadNewEntries)
                self._loadEntries();

            self._setEmptyViewMessage();

            if (self._loadedEntries.length) {
                let newSelection = self._loadedEntries[selectedEntryIndex] != -1
                                   ? self._loadedEntries[selectedEntryIndex]
                                   : self._loadedEntries[self._loadedEntries.length - 1];
                self.selectEntry(newSelection);
            }
        }

        if (indices.length == 1 && aAnimate) {
            let entryID = this._loadedEntries[indices[0]];

            if (entryID == this.selectedEntry) {
                this.selectEntry(null);
                selectedEntryIndex = indices[0];
            }

            // Gracefully fade the entry using jQuery. For callback, the binding
            // will send EntryRemoved event when it's finished.
            this.document.addEventListener('EntryRemoved', finish, true);
            this._sendEvent(entryID, 'DoRemoveEntry');

            this._loadedEntries.splice(indices[0], 1);
        }
        else {
            indices.sort(function(a, b) a - b);

            // Start from the oldest entry so that we don't change the relative
            // insertion positions of consecutive entries.
            for (let i = indices.length - 1; i >= 0; i--) {
                let element = this.feedContent.childNodes[indices[i]];
                this.feedContent.removeChild(element);

                if (this._loadedEntries[indices[i]] == this.selectedEntry) {
                    this.selectEntry(null);
                    selectedEntryIndex = indices[i];
                }

                this._loadedEntries.splice(indices[i], 1);
            }

            finish();
        }
    },


    /**
     * Refreshes the feed view. Removes the old content and builds the new one.
     */
    refresh: function FeedView_refresh() {
        if (!this.active)
            return;

        this._stopSmoothScrolling();
        clearTimeout(this._markVisibleTimeout);
        getTopWindow().StarUI.panel.hidePopup();

        // Clear the old entries.
        var container = this.document.getElementById('container');
        container.removeChild(this.feedContent);
        var content = this.document.createElement('div');
        content.id = 'feed-content';
        container.appendChild(content);

        var feed = gStorage.getFeed(this.query.feeds);

        this._buildHeader(feed);

        // Pass parameters to content.
        if (this.query.deleted == ENTRY_STATE_TRASHED)
            this.feedContent.setAttribute('trash', true);
        if (gPrefs.showHeadlinesOnly)
            this.feedContent.setAttribute('showHeadlinesOnly', true);
        if (!feed)
            this.feedContent.setAttribute('showFeedNames', true);

        this._loadedEntries = [];

        // Append the predefined initial number of entries and if necessary, keep
        // appending more until they fill WINDOW_HEIGHTS_LOAD + 1 of window heights.
        var query = this.getQuery();
        query.limit = gPrefs.minInitialEntries;
        var win = this.window;

        // Temporarily remove the listener because reading window.innerHeight
        // can trigger a resize event (!?).
        this.window.removeEventListener('resize', this, false);

        while (win.scrollMaxY - win.pageYOffset < win.innerHeight * WINDOW_HEIGHTS_LOAD) {
            let entries = query.getFullEntries();
            if (!entries.length)
                break;

            entries.forEach(this._appendEntry, this);

            query.offset += query.limit;
            query.limit = LOAD_STEP_SIZE;
        }

        // Resize events can be dispatched asynchronously, so this listener can't be
        // added in FeedView.attach() like the others, because it could be triggered
        // before the initial refresh.
        this.window.addEventListener('resize', this, false);

        this._asyncRefreshEntryList();
        this._setEmptyViewMessage();
        this._markVisibleAsRead();

        // Initialize selection.
        if (gPrefs.entrySelectionEnabled) {
            let entry = (this._loadedEntries.indexOf(this.selectedEntry) != -1)
                        ? this.selectedEntry
                        : this._loadedEntries[0];
            this.selectEntry(entry, true);
        }
        else {
            this.window.scroll(this.window.pageXOffset, 0);
        }

        // Changing content may cause a scroll event which should be ignored.
        this._ignoreScrollEvent = true;
    },

    /**
     * Asynchronously refreshes the list of IDs of all contained entries.
     */
    _asyncRefreshEntryList: function FeedView__asyncRefreshEntryList() {
        this._entries = null;
        async(function() {
            if (!this.__entries)
                this._entries = this.query.getEntries();
        }, 250, this);
    },

    /**
     * Incrementally loads the next part of entries.
     */
    _loadEntries: function FeedView__loadEntries() {
        var win = this.document.defaultView;
        var middleEntry = this._getMiddleEntryElement();

        if (win.scrollMaxY - win.pageYOffset > win.innerHeight * MIN_LOADED_WINDOW_HEIGHTS
            && middleEntry != this.feedContent.lastChild) {
            return;
        }

        while ((win.scrollMaxY - win.pageYOffset < win.innerHeight * WINDOW_HEIGHTS_LOAD
                || middleEntry == this.feedContent.lastChild)
               && this._loadedEntries.length < this._entries.length) {
            let startIndex = this._loadedEntries.length;
            let endIndex = Math.min(startIndex + LOAD_STEP_SIZE, this._entries.length - 1);
            let entries = this._entries.slice(startIndex, endIndex + 1);
            this._getFastQuery(entries).getFullEntries().forEach(this._appendEntry, this);
        }
    },

    _appendEntry: function FeedView__appendEntry(aEntry) {
        this._insertEntry(aEntry, this._loadedEntries.length);
        this._loadedEntries.push(aEntry.id);
    },

    _insertEntry: function FeedView__appendEntry(aEntry, aPosition) {
        var articleContainer = this.document.createElement('div');
        articleContainer.className = 'article-container';

        // Safely pass the data so that binding constructor can use it.
        articleContainer.setAttribute('id', aEntry.id);
        articleContainer.setAttribute('entryURL', aEntry.entryURL);
        articleContainer.setAttribute('entryTitle', aEntry.title);
        articleContainer.setAttribute('content', aEntry.content);
        articleContainer.setAttribute('tags', aEntry.tags);

        if (aEntry.authors)
            articleContainer.setAttribute('authors', this.authorPrefixStr + aEntry.authors);
        if (aEntry.read)
            articleContainer.setAttribute('read', true);
        if (aEntry.starred)
            articleContainer.setAttribute('starred', true);

        articleContainer.setAttribute('date', aEntry.date);

        var dateString = this._constructEntryDate(aEntry);
        articleContainer.setAttribute('dateString', dateString);
        if (aEntry.updated) {
            dateString += ' <span class="article-updated">' + this.updatedStr + '</span>'
            articleContainer.setAttribute('updatedString', dateString);
            articleContainer.setAttribute('updated', true);
        }

        var feedName = gStorage.getFeed(aEntry.feedID).title;
        articleContainer.setAttribute('feedName', feedName);

        if (gPrefs.showHeadlinesOnly)
            articleContainer.setAttribute('collapsed', true);

        var nextEntry = this.feedContent.childNodes[aPosition];
        this.feedContent.insertBefore(articleContainer, nextEntry);

        // Highlight search terms.
        if (this.query.searchString) {
            let header = articleContainer.firstChild;
            let tags = this._getAnonElement(header, 'article-tags');
            let authors = this._getAnonElement(header, 'article-authors');
            let terms = this.query.searchString.match(/[A-Za-z0-9]+/g);
            for each (term in terms) {
                this._highlightText(term, articleContainer);
                this._highlightText(term, authors);
                this._highlightText(term, tags);
            }
        }

        return articleContainer;
    },


    _constructEntryDate: function FeedView__constructEntryDate(aEntry) {
        var entryDate = new Date(aEntry.date);
        var entryTime = entryDate.getTime() - entryDate.getTimezoneOffset() * 60000;

        var now = new Date();
        var nowTime = now.getTime() - now.getTimezoneOffset() * 60000;

        var today = Math.ceil(nowTime / 86400000);
        var entryDay = Math.ceil(entryTime / 86400000);
        var deltaDays = today - entryDay;
        var deltaYears = Math.ceil(today / 365) - Math.ceil(entryDay / 365);

        var string = '';
        switch (true) {
            case deltaDays === 0:
                string = entryDate.toLocaleFormat(', %X ');
                string = this.todayStr + string;
                break;
            case deltaDays === 1:
                string = entryDate.toLocaleFormat(', %X ');
                string = this.yesterdayStr + string
                break;
            case deltaDays < 7:
                string = entryDate.toLocaleFormat('%A, %X ');
                break;
            case deltaYears > 0:
                string = entryDate.toLocaleFormat('%d %B %Y, %X ');
                break;
            default:
                string = entryDate.toLocaleFormat('%d %B, %X ');
        }

        string = string.replace(/:\d\d /, ' ');
        // XXX We do it because %e conversion specification doesn't work
        string = string.replace(/^0/, '');

        return string;
    },

    _buildHeader: function FeedView__buildHeader(aFeed) {
        var feedTitle = getElement('feed-title');

        // Reset the old header.
        feedTitle.removeAttribute('href');
        feedTitle.className = '';

        feedTitle.textContent = this.titleOverride || this.title;

        if (aFeed) {
            let url = aFeed.websiteURL || aFeed.feedURL;
            let flags = Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL;
            let securityCheckOK = true;
            try {
                gSecurityManager.checkLoadURIStrWithPrincipal(gBriefPrincipal, url,
                                                              flags);
            }
            catch (ex) {
                log('Brief: security error.' + ex);
                securityCheckOK = false;
            }

            if (securityCheckOK && !this.query.searchString) {
                feedTitle.setAttribute('href', url);
                feedTitle.className = 'feed-link';
            }
        }
    },

    _setEmptyViewMessage: function FeedView__setEmptyViewMessage() {
        if (this._loadedEntries.length) {
            this.document.getElementById('message').style.display = 'none';
            return;
        }

        var paragraph = this.document.getElementById('message');
        var bundle = getElement('main-bundle');
        var message;

        if (this.query.searchString)
            message = bundle.getString('noEntriesFound');
        else if (this.query.unread)
            message = bundle.getString('noUnreadEntries');
        else if (this.query.starred && this.starredParamFixed)
            message = bundle.getString('noStarredEntries');
        else if (this.query.starred)
            message = bundle.getString('noStarredEntriesInFeed');
        else if (this.query.deleted == ENTRY_STATE_TRASHED)
            message = bundle.getString('trashIsEmpty');
        else
            message = bundle.getString('noEntries');

        paragraph.textContent = message;
        paragraph.style.display = 'block';
    },


    _highlightText: function FeedView__highlightText(aWord, aContainer) {
        var searchRange = this.document.createRange();
        searchRange.setStart(aContainer, 0);
        searchRange.setEnd(aContainer, aContainer.childNodes.length);

        var startPoint = this.document.createRange();
        startPoint.setStart(aContainer, 0);
        startPoint.setEnd(aContainer, 0);

        var endPoint = this.document.createRange();
        endPoint.setStart(aContainer, aContainer.childNodes.length);
        endPoint.setEnd(aContainer, aContainer.childNodes.length);

        var baseNode = this.document.createElement('span');
        baseNode.className = 'search-highlight';

        var finder = Cc['@mozilla.org/embedcomp/rangefind;1'].createInstance(Ci.nsIFind);
        finder.caseSensitive = false;

        var retRange;
        while (retRange = finder.Find(aWord, searchRange, startPoint, endPoint)) {
            let surroundingNode = baseNode.cloneNode(false);
            surroundingNode.appendChild(retRange.extractContents());

            let before = retRange.startContainer.splitText(retRange.startOffset);
            before.parentNode.insertBefore(surroundingNode, before);

            startPoint.setStart(surroundingNode, surroundingNode.childNodes.length);
            startPoint.setEnd(surroundingNode, surroundingNode.childNodes.length);
        }
    },

    QueryInterface: function FeedView_QueryInterface(aIID) {
        if (aIID.equals(Ci.nsISupports) ||
            aIID.equals(Ci.nsIDOMEventListener) ||
            aIID.equals(Ci.nsIBriefStorageObserver) ||
            aIID.equals(Ci.nsIObserver)) {
            return this;
        }
        throw Components.results.NS_ERROR_NO_INTERFACE;
    }

}
