// Minimal number of window heights worth of entries loaded ahead of the
// current scrolling position at any given time.
const MIN_LOADED_WINDOW_HEIGHTS = 1;

// Number of window heights worth of entries to load when the above threshold is crossed.
const WINDOW_HEIGHTS_LOAD = 2;

// Number of window heights worth of entries to load when creating a view.
const INITIAL_WINDOW_HEIGHTS_LOAD = 2;

// Number of entries queried in each step until they fill the defined height.
const LOAD_STEP_SIZE = 5;

// Same as above, but applies to headlines view.
const HEADLINES_LOAD_STEP_SIZE = 10;


// The currently active instance of FeedView.
var gCurrentView = null;

/**
 * This object represents the main feed display. It stores and manages display parameters.
 * The feed is displayed using a local, unprivileged template page. We insert third-party
 * content in it (entries are served with full HTML markup), so the template page has to
 * be untrusted and we respect XPCNativeWrappers when interacting with it. Individual
 * entries are inserted dynamically and have their own XBL bindings.
 *
 * @param aTitle
 *        Title of the view which will be shown in the header.
 * @param aQuery
 *        Query which selects contained entries.
 * @param aFixedUnread
 *        Indicates that the "unread" query parameter is fixed and the view
 *        isn't affected by feedview.filterUnread pref.
 * @param aFixedStarred
 *        Indicates that the "starred" query parameter is fixed and the
 *        isn't view affected by feedview.filterStarred pref.
 */
function FeedView(aTitle, aQuery, aFixedUnread, aFixedStarred) {
    this.title = aTitle;
    this.fixedUnread = aFixedUnread || false;
    this.fixedStarred = aFixedStarred || false;

    aQuery.sortOrder = Query.prototype.SORT_BY_DATE;
    this.query = aQuery;

    // Ordered array of IDs of entries that have been loaded.
    this._loadedEntries = [];

    // List of entries manually marked as unread by the user. They won't be
    // marked as read again when autoMarkRead is on.
    this.entriesMarkedUnread = [];

    if (gCurrentView)
        gCurrentView.uninit();
    else
        var noExistingView = true;

    if (!this.query.searchString)
        getElement('searchbar').value = '';

    // Disable filters for views with fixed parameters.
    getElement('filter-unread-checkbox').disabled = this.fixedUnread;
    getElement('filter-starred-checkbox').disabled = this.fixedStarred;

    this.browser.addEventListener('load', this, false);
    getTopWindow().gBrowser.addEventListener('TabSelect', this, false);
    Storage.addObserver(this);

    // Load the template page if it hasn't been loaded yet. We also have to make sure to
    // load it at startup, when no view was attached yet, because the template page
    // may have been restored by SessionStore - before any FeedView was attached.
    if (!this.browser.currentURI.equals(gTemplateURI) || noExistingView) {
        this.browser.loadURI(gTemplateURI.spec);
    }
    else {
        for each (let event in this._events)
            this.document.addEventListener(event, this, true);

        // Refresh asynchronously, because it might take a while
        // and UI may be waiting to be redrawn.
        async(this.refresh, 0, this);
    }
}


FeedView.prototype = {

    // Temporarily override the title without losing the old one.
    titleOverride: '',

    // ID of the selected entry.
    selectedEntry: null,

    _refreshPending: false,

    get browser() getElement('feed-view'),

    get document() this.browser.contentDocument,

    get window() this.document.defaultView,

    get feedContent() this.document.getElementById('feed-content'),

    get active() this.browser.currentURI.equals(gTemplateURI) && gCurrentView == this,

    /**
     * Query selecting all entries contained by the view.
     */
    set query(aQuery) {
        this.__query = aQuery;
        return aQuery;
    },

    get query() {
        if (!this.fixedUnread)
            this.__query.read = PrefCache.filterUnread ? false : undefined;
        if (!this.fixedStarred)
            this.__query.starred = PrefCache.filterStarred ? true : undefined;

        if (this.__query.read === false && PrefCache.sortUnreadViewOldestFirst)
            this.__query.sortDirection = Query.prototype.SORT_ASCENDING;
        else
            this.__query.sortDirection = Query.prototype.SORT_DESCENDING;

        return this.__query;
    },

    /**
     * Returns a copy of the query that selects all entries contained by the view.
     * Use this function when you want to modify the query before using it, without
     * permanently changing the view parameters.
     */
    getQueryCopy: function FeedView_getQueryCopy() {
        var query = this.query;
        var copy = new Query();
        for (let property in query)
            copy[property] = query[property];
        return copy;
    },

    collapseEntry: function FeedView_collapseEntry(aEntry, aNewState, aAnimate) {
        if (aNewState)
            var eventType = aAnimate ? 'CollapseEntryAnimated' : 'CollapseEntry';
        else
            eventType = aAnimate ? 'UnCollapseEntryAnimated' : 'UnCollapseEntry';

        var evt = this.document.createEvent('Events');
        evt.initEvent(eventType, false, false);
        this.document.getElementById(aEntry).dispatchEvent(evt);
    },

    get selectedElement() {
        return this.selectedEntry ? this.document.getElementById(this.selectedEntry)
                                  : null;
    },

    selectNextEntry: function FeedView_selectNextEntry() {
        if (this._scrolling)
            return;

        if (PrefCache.entrySelectionEnabled) {
            var entryElement = this.selectedElement.nextSibling;
            if (entryElement)
                this.selectEntry(parseInt(entryElement.id), true, true);
        }
        else {
            Prefs.setBoolPref('feedview.entrySelectionEnabled', true);
        }
    },

    selectPrevEntry: function FeedView_selectPrevEntry() {
        if (this._scrolling)
            return;

        if (PrefCache.entrySelectionEnabled) {
            var entryElement = this.selectedElement.previousSibling;
            if (entryElement)
                this.selectEntry(parseInt(entryElement.id), true, true);
        }
        else {
            Prefs.setBoolPref('feedview.entrySelectionEnabled', true);
        }
    },

    /**
     * Selects the given entry and optionally scrolls it into view.
     *
     * @param aEntry
     *        ID or DOM element of entry to select.
     *        Pass null to deselect current entry.
     * @param aScroll
     *        Set to TRUE to scroll the entry into view.
     * @param aScrollSmoothly
     *        Set to TRUE to scroll smoothly, FALSE to jump
     *        directly to the target position.
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
     * @param aSmooth
     *        Set to TRUE to scroll smoothly, FALSE to jump directly to the
     *        target position.
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
     * Scroll down by 10 entries, loading more entries if necessary.
     */
    skipDown: function FeedView_skipDown() {
        var middleEntry = parseInt(this._getMiddleEntryElement().id);
        var index = this._loadedEntries.indexOf(middleEntry);
        if (index + 10 > this._loadedEntries.length - 1)
            this._loadEntries(10);

        var targetEntry = this._loadedEntries[index + 10] ||
                          this._loadedEntries[this._loadedEntries.length - 1];

        if (PrefCache.entrySelectionEnabled)
            this.selectEntry(targetEntry, true, true);
        else
            this.scrollToEntry(targetEntry, true);
    },

    // See scrollDown.
    skipUp: function FeedView_skipUp() {
        var middleEntry = parseInt(this._getMiddleEntryElement().id);
        var index = this._loadedEntries.indexOf(middleEntry);
        var targetEntry = this._loadedEntries[index - 10] || this._loadedEntries[0];

        if (PrefCache.entrySelectionEnabled)
            this.selectEntry(targetEntry, true, true);
        else
            this.scrollToEntry(targetEntry, true);
    },


    /**
     * Scroll entry into view. If the entry is taller than the height of the screen,
     * the scroll position is aligned with the top of the entry, otherwise the entry
     * is positioned in the middle of the screen.
     *
     * @param aEntry
     *        ID of entry to scroll to.
     * @param aSmooth
     *        Set to TRUE to scroll smoothly, FALSE to jump directly to the
     *        target position.
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
                self._ignoreNextScrollEvent = true;
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

        // Iterate starting from the last entry, because the scroll position is
        // likely to be closer to the end than to the beginning of the page.
        for (let i = elems.length - 1; i >= 0; i--) {
            if ((elems[i].offsetTop <= middleLine)
                && (!elems[i + 1] || elems[i + 1].offsetTop > middleLine)) {
                var middleElement = elems[i];
                break;
            }
        }

        return middleElement || elems[elems.length - 1];
    },

    _autoMarkRead: function FeedView__autoMarkRead() {
        if (PrefCache.autoMarkRead && !PrefCache.showHeadlinesOnly && this.query.read !== false) {
            clearTimeout(this._markVisibleTimeout);
            this._markVisibleTimeout = async(this.markVisibleEntriesRead, 1000, this);
        }
    },

    markVisibleEntriesRead: function FeedView_markVisibleEntriesRead() {
        var winTop = this.window.pageYOffset;
        var winBottom = winTop + this.window.innerHeight;
        var entries = this.feedContent.childNodes;

        var entriesToMark = [];

        // Iterate starting from the last entry, because the scroll position is
        // likely to be closer to the end than to the beginning of the page.
        for (let i = entries.length - 1; i >= 0; i--) {
            let entryTop = entries[i].offsetTop;
            let id = parseInt(entries[i].id);
            let wasMarkedUnread = (this.entriesMarkedUnread.indexOf(id) != -1);

            if (entryTop >= winTop && entryTop < winBottom - 50 && !wasMarkedUnread)
                entriesToMark.push(id);
        }

        if (entriesToMark.length)
            new Query(entriesToMark).markEntriesRead(true);
    },

    toggleHeadlinesView: function FeedView_toggleHeadlinesView() {
        this._loadedEntries.forEach(function(entry) {
            this.collapseEntry(entry, PrefCache.showHeadlinesOnly, false);
        }, this)

        if (PrefCache.showHeadlinesOnly) {
            this.feedContent.setAttribute('showHeadlinesOnly', true);
            this._fillWindow(WINDOW_HEIGHTS_LOAD);
        }
        else {
            this.feedContent.removeAttribute('showHeadlinesOnly');
            this._autoMarkRead();
        }
    },


    /**
     * Deactivates the view.
     */
    uninit: function FeedView_uninit() {
        getTopWindow().gBrowser.removeEventListener('TabSelect', this, false);
        this.document.removeEventListener('EntryRemoved', this._onEntriesRemovedFinish, true);
        this.browser.removeEventListener('load', this, false);
        this.window.removeEventListener('resize', this, false);
        for each (let event in this._events)
            this.document.removeEventListener(event, this, true);

        Storage.removeObserver(this);

        this._stopSmoothScrolling();
        clearTimeout(this._markVisibleTimeout);
    },


    /**
     * Events which the view listens to in the template page.
     */
    _events: ['EntryUncollapsed', 'click', 'scroll', 'keypress'],

    handleEvent: function FeedView_handleEvent(aEvent) {
        var target = aEvent.target;
        var id = parseInt(target.id);

        // Checking if default action has been prevented helps Brief play nicely with
        // other extensions. In Gecko <1.9.2 getPreventDefault() is available only
        // for UI events.
        if (aEvent instanceof Ci.nsIDOMNSUIEvent && aEvent.getPreventDefault())
            return;

        switch (aEvent.type) {

            case 'EntryUncollapsed':
                if (PrefCache.autoMarkRead && this.query.read !== false)
                    Commands.markEntryRead(id, true);

                if (id == this.selectedEntry) {
                    alignWithTop = (this.selectedElement.offsetHeight > this.window.innerHeight);
                    this.selectedElement.scrollIntoView(alignWithTop);
                }
                break;

            // Set up the template page when it's loaded.
            case 'load':
                getElement('feed-view-header').hidden = !this.active;

                if (this.active) {
                    this.window.addEventListener('resize', this, false);
                    for each (let event in this._events)
                        this.document.addEventListener(event, this, true);

                    // Some feeds include scripts that use document.write() which screw
                    // us up, because we insert them dynamically after the page is loaded.
                    document.write = document.writeln = function() { };

                    this.refresh();
                }
                break;

            case 'scroll':
                this._autoMarkRead();

                if (this._ignoreNextScrollEvent) {
                    this._ignoreNextScrollEvent = false;
                    break;
                }

                if (PrefCache.entrySelectionEnabled && !this._scrolling) {
                    clearTimeout(this._scrollSelectionTimeout);

                    function selectCentralEntry() {
                        let elem = this._getMiddleEntryElement();
                        this.selectEntry(elem);
                    }
                    this._scrollSelectionTimeout = async(selectCentralEntry, 100, this);
                }

                this._fillWindow(WINDOW_HEIGHTS_LOAD);
                break;

            case 'resize':
                this._fillWindow(WINDOW_HEIGHTS_LOAD);
                break;

            case 'click':
                this._onClick(aEvent);
                break;

            case 'keypress':
                onKeyPress(aEvent);
                break;

            case 'TabSelect':
                if (aEvent.originalTarget == getTopWindow().Brief.tab && this._refreshPending) {
                    this.refresh();
                    this._refreshPending = false;
                }
                break;
        }
    },

    _onClick: function FeedView__onClick(aEvent) {
        // This loop walks the parent chain of the even target to check if the
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

        // Divert links to new tabs according to user preferences.
        if (anchor && (aEvent.button == 0 || aEvent.button == 1)) {
            aEvent.preventDefault();

            // preventDefault doesn't stop the default action for middle-clicks,
            // so we've got stop propagation as well.
            if (aEvent.button == 1)
                aEvent.stopPropagation();

            var openInTabs = Prefs.getBoolPref('feedview.openEntriesInTabs');
            var newTab = openInTabs || aEvent.button == 1 || aEvent.ctrlKey;

            if (anchor.className == 'article-title-link')
                Commands.openEntryLink(entryElement, newTab);
            else if (anchor.hasAttribute('href'))
                Commands.openLink(anchor.getAttribute('href'), newTab);
        }

        if (!entryElement)
            return;

        if (PrefCache.entrySelectionEnabled)
            this.selectEntry(parseInt(entryElement.id));

        var entryID = parseInt(entryElement.id);
        var command = aEvent.target.getAttribute('command');

        if (aEvent.detail == 2 && PrefCache.doubleClickMarks && !command)
            Commands.markEntryRead(entryID, !entryElement.hasAttribute('read'));

        if (command) {
            switch (command) {
                case 'switchRead':
                    Commands.markEntryRead(entryID, !entryElement.hasAttribute('read'));
                    break;

                case 'star':
                    if (entryElement.hasAttribute('starred')) {
                        let query = new Query(entryID);
                        query.verifyBookmarksAndTags();
                        let itemID = query.getProperty('bookmarkID')[0].bookmarkID;

                        let starElem = entryElement.getElementsByClassName('article-star')[0];
                        getTopWindow().StarUI.showEditBookmarkPopup(itemID, starElem, 'after_start');
                    }
                    else {
                        Commands.starEntry(entryID, true);
                    }
                    break;

                case 'delete':
                    Commands.deleteEntry(entryID);
                    break;

                case 'restore':
                    Commands.restoreEntry(entryID);
                    break;
            }
        }
        else if (entryElement.hasAttribute('collapsed')) {
            this.collapseEntry(entryID, false, true);
        }
        else {
            let className = aEvent.target.className;
            if ((className == 'article-header' || className == 'article-title-link-box')
                    && PrefCache.showHeadlinesOnly) {
                this.collapseEntry(entryID, true, true);
            }
        }
    },

    onEntriesAdded: function FeedView_onEntriesAdded(aEntryList) {
        if (getTopWindow().gBrowser.selectedTab != getTopWindow().Brief.tab) {
            this._refreshPending = true;
            return;
        }

        if (this.active)
            this._onEntriesAdded(aEntryList.IDs);
    },

    onEntriesUpdated: function FeedView_onEntriesUpdated(aEntryList) {
        if (getTopWindow().gBrowser.selectedTab != getTopWindow().Brief.tab) {
            this._refreshPending = true;
            return;
        }

        if (this.active) {
            this._onEntriesRemoved(aEntryList.IDs, false, false);
            this._onEntriesAdded(aEntryList.IDs);
        }
    },

    onEntriesMarkedRead: function FeedView_onEntriesMarkedRead(aEntryList, aNewState) {
        if (!this.active)
            return;

        if (this.query.read === false) {
            if (aNewState)
                this._onEntriesRemoved(aEntryList.IDs, true, true);
            else
                this._onEntriesAdded(aEntryList.IDs);
        }

        intersect(this._loadedEntries, aEntryList.IDs).forEach(function(entry) {
            let entryElement = this.document.getElementById(entry);
            let markReadButton = entryElement.getElementsByClassName('mark-read-centre')[0];

            if (aNewState) {
                entryElement.setAttribute('read', 'true');
                markReadButton.textContent = this._strings.markAsUnread;

                // XXX
                if (entryElement.hasAttribute('updated')) {
                    entryElement.removeAttribute('updated');
                    let dateElement = entryElement.getElementsByClassName('article-date')[0];
                    dateElement.innerHTML = entryElement.getAttribute('dateString');
                }
            }
            else {
                entryElement.removeAttribute('read');
                markReadButton.textContent = this._strings.markAsRead;
            }
        }, this)
    },

    onEntriesStarred: function FeedView_onEntriesStarred(aEntryList, aNewState) {
        if (!this.active)
            return;

        if (this.query.starred === true) {
            if (aNewState)
                this._onEntriesAdded(aEntryList.IDs);
            else
                this._onEntriesRemoved(aEntryList.IDs, true, true);
        }

        intersect(this._loadedEntries, aEntryList.IDs).forEach(function(entry) {
            let entryElement = this.document.getElementById(entry);
            if (aNewState)
                entryElement.setAttribute('starred', 'true');
            else
                entryElement.removeAttribute('starred');
        }, this)
    },

    onEntriesTagged: function FeedView_onEntriesTagged(aEntryList, aNewState, aTag) {
        if (!this.active)
            return;

        intersect(this._loadedEntries, aEntryList.IDs).forEach(function(entry) {
            let entryElement = this.document.getElementById(entry);

            let tags = entryElement.getAttribute('tags');
            tags = tags ? tags.split(', ') : [];

            if (aNewState) {
                tags.push(aTag);
                tags.sort();
            }
            else {
                let index = tags.indexOf(aTag);
                tags.splice(index, 1);
            }

            tags = tags.join(', ');

            entryElement.setAttribute('tags', tags);
            var tagsElement = entryElement.getElementsByClassName('article-tags')[0];
            tagsElement.textContent = tags;
        }, this)

        if (this.query.tags && this.query.tags[0] === aTag) {
            if (aNewState)
                this._onEntriesAdded(aEntryList.IDs);
            else
                this._onEntriesRemoved(aEntryList.IDs, true, true);
        }
    },

    onEntriesDeleted: function FeedView_onEntriesDeleted(aEntryList, aNewState) {
        if (!this.active)
            return;

        if (aNewState === this.query.deleted)
            this._onEntriesAdded(aEntryList.IDs);
        else
            this._onEntriesRemoved(aEntryList.IDs, true, true);
    },


    /**
     * Checks if given entries belong to the view and inserts them.
     *
     * If the previously loaded entries fill the window, the added entries need to
     * be inserted only if they have a more recent date than the last loaded
     * entry. We can use the date of the last loaded entry as an anchor and
     * determine the new list of entries by selecting entries with a newer date
     * than that.
     * However, this doesn't work if the previously loaded entries don't fill
     * the window, in which case we must do a full refresh.
     *
     * @param aAddedEntries
     *        Array of IDs of entries.
     */
    _onEntriesAdded: function FeedView__onEntriesAdded(aAddedEntries) {
        var win = this.window;
        if (win.scrollMaxY - win.pageYOffset < win.innerHeight * MIN_LOADED_WINDOW_HEIGHTS) {
            this.refresh()
            return;
        }

        var query = this.getQueryCopy();
        query.startDate = parseInt(this.feedContent.lastChild.getAttribute('date'));
        this._loadedEntries = query.getEntries();

        function filterNew(entryID) this._loadedEntries.indexOf(entryID) != -1;
        var newEntries = aAddedEntries.filter(filterNew, this);

        if (newEntries.length) {
            let query = new Query({
                sortOrder: this.query.sortOrder,
                sortDirection: this.query.sortDirection,
                entries: newEntries
            })

            query.getFullEntries().forEach(function(entry) {
                let index = this._loadedEntries.indexOf(entry.id);
                this._insertEntry(entry, index);
            }, this)

            this._setEmptyViewMessage();
        }
    },

    /**
     * Checks if given entries are in the view and removes them.
     *
     * @param aRemovedEntries
     *        Array of IDs of entries.
     * @param aAnimate
     *        Use animation when a single entry is being removed.
     * @param aLoadNewEntries
     *        Load new entries to fill the screen.
     */
    _onEntriesRemoved: function FeedView__onEntriesRemoved(aRemovedEntries, aAnimate,
                                                           aLoadNewEntries) {
        var indices = aRemovedEntries.map(function(e) this._loadedEntries.indexOf(e), this)
                                     .filter(function(i) i != -1);
        if (!indices.length)
            return;

        // Removing content may cause a scroll event, which should be ignored.
        this._ignoreNextScrollEvent = true;
        getTopWindow().StarUI.panel.hidePopup();

        // Remember index of selected entry if it is removed.
        var selectedEntryIndex = -1;

        let self = this;
        this._onEntriesRemovedFinish = function() {
            self.document.removeEventListener('EntryRemoved', arguments.callee, true);

            if (aLoadNewEntries)
                self._fillWindow(WINDOW_HEIGHTS_LOAD);

            self._setEmptyViewMessage();

            if (self._loadedEntries.length && selectedEntryIndex != -1) {
                let newSelection = self._loadedEntries[selectedEntryIndex] ||
                                   self._loadedEntries[self._loadedEntries.length - 1];
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
            this.document.addEventListener('EntryRemoved', this._onEntriesRemovedFinish, true);

            var evt = this.document.createEvent('Events');
            evt.initEvent('RemoveEntry', false, false);
            this.document.getElementById(entryID).dispatchEvent(evt);

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

            this._onEntriesRemovedFinish();
        }
    },


    /**
     * Refreshes the feed view. Removes the old content and builds the new one.
     */
    refresh: function FeedView_refresh() {
        if (!this.active)
            return;

        this._stopSmoothScrolling();
        this.document.removeEventListener('EntryRemoved', this._onEntriesRemovedFinish, true);
        clearTimeout(this._markVisibleTimeout);
        getTopWindow().StarUI.panel.hidePopup();

        // Clear the old entries.
        var container = this.document.getElementById('container');
        container.removeChild(this.feedContent);
        var content = this.document.createElement('div');
        content.id = 'feed-content';
        container.appendChild(content);

        var feed = Storage.getFeed(this.query.feeds);

        this._buildHeader(feed);

        // Pass parameters to content.
        if (this.query.deleted == Storage.ENTRY_STATE_TRASHED)
            this.feedContent.setAttribute('trash', true);
        if (PrefCache.showHeadlinesOnly)
            this.feedContent.setAttribute('showHeadlinesOnly', true);

        this._loadedEntries = [];

        // Temporarily remove the listener because reading window.innerHeight
        // can trigger a resize event (!?).
        this.window.removeEventListener('resize', this, false);

        this._fillWindow(INITIAL_WINDOW_HEIGHTS_LOAD);

        // Resize events can be dispatched asynchronously, so this listener can't be
        // added in FeedView.attach() like the others, because then it could be
        // triggered before the initial refresh.
        this.window.addEventListener('resize', this, false);

        this._setEmptyViewMessage();
        this._autoMarkRead();

        // Initialize selection.
        if (PrefCache.entrySelectionEnabled) {
            let entry = (this._loadedEntries.indexOf(this.selectedEntry) != -1)
                        ? this.selectedEntry
                        : this._loadedEntries[0];
            this.selectEntry(entry, true);
        }
        else {
            this.window.scroll(this.window.pageXOffset, 0);
        }

        // Changing content may cause a scroll event which should be ignored.
        this._ignoreNextScrollEvent = true;
    },


    /**
     * Loads more entries if the loaded entries don't fill the specified minimal
     * number of window heights ahead of the current scroll position.
     *
     * @param aWindowHeights
     *        The number of window heights to fill ahead of the current scroll
     *        position.
     */
    _fillWindow: function FeedView__fillWindow(aWindowHeights) {
        var win = this.document.defaultView;
        var middleEntry = this._getMiddleEntryElement();

        if (win.scrollMaxY - win.pageYOffset > win.innerHeight * MIN_LOADED_WINDOW_HEIGHTS
                && middleEntry != this.feedContent.lastChild) {
            return;
        }

        var stepSize = PrefCache.showHeadlinesOnly ? HEADLINES_LOAD_STEP_SIZE
                                                   : LOAD_STEP_SIZE;

        var loadedEntriesCount = this._loadEntries(stepSize);

        while ((win.scrollMaxY - win.pageYOffset < win.innerHeight * aWindowHeights
               || middleEntry == this.feedContent.lastChild) && loadedEntriesCount) {

            loadedEntriesCount = this._loadEntries(stepSize);
        }
    },

    /**
     * Queries and appends a requested number of entries. The actual number of loaded
     * entries may be different. If there are many entries with the same date, we must
     * make sure to load all of them in a single batch, in order to avoid loading them
     * again later.
     *
     * @param aCount
     *        Requested number of entries.
     * @return The actual number of entries that were loaded.
     */
    _loadEntries: function FeedView__loadEntries(aCount) {
        var lastEntryElem = this.feedContent.lastChild;
        var endDate = lastEntryElem ? parseInt(lastEntryElem.getAttribute('date')) - 1
                                    : undefined;

        var dateQuery = this.getQueryCopy();
        dateQuery.endDate = endDate;
        dateQuery.limit = aCount;

        var entryDates = dateQuery.getProperty('date');
        if (!entryDates.length)
            return 0;

        var query = this.getQueryCopy();
        query.startDate = entryDates[entryDates.length - 1].date;
        query.endDate = endDate;

        var entries = query.getFullEntries();
        entries.forEach(this._appendEntry, this);

        return entries.length;
    },

    _appendEntry: function FeedView__appendEntry(aEntry) {
        this._insertEntry(aEntry, this._loadedEntries.length);
        this._loadedEntries.push(aEntry.id);
    },

    _insertEntry: function FeedView__appendEntry(aEntry, aPosition) {
        var template = this.document.getElementById('article-template');
        var entryContainer = template.cloneNode(true);

        var nextEntry = this.feedContent.childNodes[aPosition];
        this.feedContent.insertBefore(entryContainer, nextEntry);

        entryContainer.setAttribute('id', aEntry.id);

        if (aEntry.read)
            entryContainer.setAttribute('read', true);

        var titleElem = entryContainer.getElementsByClassName('article-title-link')[0];
        if (aEntry.entryURL) {
            entryContainer.setAttribute('entryURL', aEntry.entryURL);
            titleElem.setAttribute('href', aEntry.entryURL);
        }

        // Use innerHTML instead of textContent, so that the entities are resolved.
        titleElem.innerHTML = aEntry.title || aEntry.entryURL;

        var tagsElem = entryContainer.getElementsByClassName('article-tags')[0];
        tagsElem.textContent = aEntry.tags;

        var markReadElem = entryContainer.getElementsByClassName('mark-read-centre')[0];
        markReadElem.textContent = aEntry.read ? this._strings.markAsUnread
                                               : this._strings.markAsRead;

        var contentElem = entryContainer.getElementsByClassName('article-content')[0];
        contentElem.innerHTML = aEntry.content;

        // When view contains entries from many feeds, show feed name on each entry.
        if (!Storage.getFeed(this.query.feeds)) {
            let feedNameElem = entryContainer.getElementsByClassName('feed-name')[0];
            feedNameElem.innerHTML = Storage.getFeed(aEntry.feedID).title;
        }

        var authorsElem = entryContainer.getElementsByClassName('article-authors')[0];
        if (aEntry.authors) {
            authorsElem.innerHTML = aEntry.authors;
        }

        if (aEntry.starred)
            entryContainer.setAttribute('starred', true);

        entryContainer.setAttribute('date', aEntry.date);

        var dateString = this._constructEntryDate(aEntry);
        if (aEntry.updated) {
            var updatedString = dateString + ' <span class="article-updated">'
                                + this._strings.entryUpdated + '</span>'
            entryContainer.setAttribute('updated', true);
        }

        var dateElem = entryContainer.getElementsByClassName('article-date')[0];
        dateElem.innerHTML = updatedString || dateString;

        if (PrefCache.showHeadlinesOnly)
            this.collapseEntry(aEntry.id, true, false);

        // Highlight search terms. For some reason doing it synchronously does not work.
        if (this.query.searchString) {
            async(function() {
                this.query.searchString.match(/[A-Za-z0-9]+/g).forEach(function(term) {
                    this._highlightText(term, entryContainer);
                }, this)
            }, 0, this)
        }

        return entryContainer;
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
                string = this._strings.today + string;
                break;
            case deltaDays === 1:
                string = entryDate.toLocaleFormat(', %X ');
                string = this._strings.yesterday + string
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
        // We do it because %e conversion specification doesn't work
        string = string.replace(/^0/, '');

        return string;
    },

    _buildHeader: function FeedView__buildHeader(aFeed) {
        var feedTitle = getElement('feed-title');

        // Reset the header.
        feedTitle.removeAttribute('href');
        feedTitle.className = '';

        feedTitle.textContent = this.titleOverride || this.title;

        if (aFeed) {
            let url = aFeed.websiteURL || aFeed.feedURL;
            let flags = Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL;
            let securityCheckOK = true;
            try {
                gSecurityManager.checkLoadURIStrWithPrincipal(gBriefPrincipal, url, flags);
            }
            catch (ex) {
                log('Brief: security error.' + ex);
                securityCheckOK = false;
            }

            if (securityCheckOK && !this.query.searchString) {
                feedTitle.setAttribute('href', url);
                feedTitle.className = 'feed-link';
            }

            feedTitle.setAttribute('tooltiptext', aFeed.subtitle);
        }
    },

    _setEmptyViewMessage: function FeedView__setEmptyViewMessage() {
        var messageBox = this.document.getElementById('message-box');
        if (this._loadedEntries.length) {
            messageBox.style.display = 'none';
            return;
        }

        var mainMessage = '', secondaryMessage = '';

        if (this.query.searchString) {
            mainMessage = gStringBundle.getString('noEntriesFound');
        }
        else if (this.query.read === false) {
            mainMessage = gStringBundle.getString('noUnreadEntries');
        }
        else if (this.query.starred === true) {
            mainMessage = gStringBundle.getString('noStarredEntries');
            secondaryMessage = gStringBundle.getString('noStarredEntriesAdvice');
        }
        else if (this.query.deleted == Storage.ENTRY_STATE_TRASHED) {
            mainMessage = gStringBundle.getString('trashIsEmpty');
        }
        else {
            mainMessage = gStringBundle.getString('noEntries');
        }

        this.document.getElementById('main-message').textContent = mainMessage;
        this.document.getElementById('secondary-message').textContent = secondaryMessage;

        messageBox.style.display = 'block';
    },

    get _strings() {
        delete this.__proto__._strings;
        return this.__proto__._strings = {
            today:        gStringBundle.getString('today'),
            yesterday:    gStringBundle.getString('yesterday'),
            entryUpdated: gStringBundle.getString('entryWasUpdated'),
            markAsRead:   gStringBundle.getString('markEntryAsRead'),
            markAsUnread: gStringBundle.getString('markEntryAsUnread'),
        }
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
            aIID.equals(Ci.nsIDOMEventListener)) {
            return this;
        }
        throw Components.results.NS_ERROR_NO_INTERFACE;
    }

}


__defineGetter__('gSecurityManager', function() {
    delete this.gSecurityManager;
    return this.gSecurityManager = Cc['@mozilla.org/scriptsecuritymanager;1']
                                   .getService(Ci.nsIScriptSecurityManager);
});

__defineGetter__('gBriefPrincipal', function() {
    var uri = NetUtil.newURI(document.documentURI);
    var resolvedURI = Cc['@mozilla.org/chrome/chrome-registry;1']
                      .getService(Ci.nsIChromeRegistry)
                      .convertChromeURL(uri);

    delete this.gBriefPrincipal;
    return this.gBriefPrincipal = gSecurityManager.getCodebasePrincipal(resolvedURI);
});