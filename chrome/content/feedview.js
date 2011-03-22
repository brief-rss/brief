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
const HEADLINES_LOAD_STEP_SIZE = 25;


// The currently active instance of FeedView.
let gCurrentView = null;

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
 */
function FeedView(aTitle, aQuery) {
    this.title = aTitle;

    // If any of read, starred, or tags parameters is specified in the query,
    // then it is fixed for the view and the user can't toggle the filter.
    this.fixedUnread = aQuery.read !== undefined;
    this.fixedStarred = aQuery.starred !== undefined || aQuery.tags !== undefined;

    getElement('filter-unread-checkbox').disabled = this.fixedUnread;
    getElement('filter-starred-checkbox').disabled = this.fixedStarred;

    aQuery.sortOrder = Query.prototype.SORT_BY_DATE;
    this.query = aQuery;

    // Array of IDs of entries that have been loaded.
    this._loadedEntries = [];

    // Array of EntryView's of entries that have been loaded.
    this._entryViews = [];

    // List of entries manually marked as unread by the user. They won't be
    // marked as read again when autoMarkRead is on.
    this._entriesMarkedUnread = [];

    if (gCurrentView)
        gCurrentView.uninit();
    else
        var noExistingView = true;

    if (!this.query.searchString)
        getElement('searchbar').value = '';

    this.browser.addEventListener('load', this, false);
    getTopWindow().gBrowser.tabContainer.addEventListener('TabSelect', this, false);
    Storage.addObserver(this);

    // Load the template page if it hasn't been loaded yet. We also have to make sure to
    // load it at startup, when no view was attached yet, because the template page
    // may have been restored by SessionStore - before any FeedView was attached.
    if (!this.browser.currentURI.equals(gTemplateURI) || noExistingView) {
        this.browser.loadURI(gTemplateURI.spec);
    }
    else {
        this.document.addEventListener('click', this, true);
        this.document.addEventListener('scroll', this, true);
        this.document.addEventListener('keypress', this, true);

        // Refresh asynchronously, because it might take a while
        // and UI may be waiting to be redrawn.
        async(this.refresh, 0, this);
    }
}


FeedView.prototype = {

    // Temporarily override the title without losing the old one.
    titleOverride: '',

    headlinesMode: false,

    // ID of the selected entry.
    selectedEntry: null,

    _refreshPending: false,


    get browser() getElement('feed-view'),

    get document() this.browser.contentDocument,

    get window() this.document.defaultView,

    get feedContent() this.document.getElementById('feed-content'),

    get active() this.browser.currentURI.equals(gTemplateURI) && gCurrentView == this,


    containsEntry: function(aEntry) this._loadedEntries.indexOf(aEntry) !== -1,

    getEntryIndex: function(aEntry) this._loadedEntries.indexOf(aEntry),

    getEntryView: function(aEntry) this._entryViews[this.getEntryIndex(aEntry)],

    get lastEntry() this._loadedEntries[this._loadedEntries.length - 1],


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
        let query = this.query;
        let copy = new Query();
        for (let property in query)
            copy[property] = query[property];
        return copy;
    },


    selectNextEntry: function FeedView_selectNextEntry() {
        if (this._scrolling)
            return;

        if (PrefCache.entrySelectionEnabled) {
            let selectedIndex = this.getEntryIndex(this.selectedEntry);
            let nextEntry = this._loadedEntries[selectedIndex + 1];
            if (nextEntry)
                this.selectEntry(nextEntry, true, true);
        }
        else {
            Prefs.setBoolPref('feedview.entrySelectionEnabled', true);
        }
    },

    selectPrevEntry: function FeedView_selectPrevEntry() {
        if (this._scrolling)
            return;

        if (PrefCache.entrySelectionEnabled) {
            let selectedIndex = this.getEntryIndex(this.selectedEntry);
            let prevEntry = this._loadedEntries[selectedIndex - 1];
            if (prevEntry)
                this.selectEntry(prevEntry, true, true);
        }
        else {
            Prefs.setBoolPref('feedview.entrySelectionEnabled', true);
        }
    },

    /**
     * Selects the given entry and optionally scrolls it into view.
     *
     * @param aEntry
     *        ID of entry to select.
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

        if (this.selectedEntry)
            this.getEntryView(this.selectedEntry).selected = false;

        this.selectedEntry = aEntry;

        if (aEntry) {
            this.getEntryView(aEntry).selected = true;

            if (aScroll)
                this.scrollToEntry(aEntry, true, aScrollSmoothly);
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
        let previousEntry = null;

        let middleEntry = this.getEntryInScreenCenter();
        if (middleEntry)
            previousEntry = this._loadedEntries[this.getEntryIndex(middleEntry) - 1];

        if (previousEntry)
            this.scrollToEntry(previousEntry, true, aSmooth);
    },


    // See scrollToPrevEntry.
    scrollToNextEntry: function FeedView_scrollToNextEntry(aSmooth) {
        let nextEntry = null;

        let middleEntry = this.getEntryInScreenCenter();
        if (middleEntry)
            nextEntry = this._loadedEntries[this.getEntryIndex(middleEntry) + 1];

        if (nextEntry)
            this.scrollToEntry(nextEntry, true, aSmooth);
    },

    /**
     * Scroll down by 10 entries, loading more entries if necessary.
     */
    skipDown: function FeedView_skipDown() {
        let middleEntry = this.getEntryInScreenCenter();
        let index = this.getEntryIndex(middleEntry);

        let doSkipDown = function(aCount) {
            let targetEntry = this._loadedEntries[index + 10] || this.lastEntry;

            if (PrefCache.entrySelectionEnabled)
                this.selectEntry(targetEntry, true, true);
            else
                this.scrollToEntry(targetEntry, true, true);
        }.bind(this);

        if (index + 10 > this._loadedEntries.length - 1)
            this._loadEntries(10, doSkipDown);
        else
            doSkipDown();
    },

    // See scrollDown.
    skipUp: function FeedView_skipUp() {
        let middleEntry = this.getEntryInScreenCenter();
        let index = this.getEntryIndex(middleEntry);
        let targetEntry = this._loadedEntries[index - 10] || this._loadedEntries[0];

        if (PrefCache.entrySelectionEnabled)
            this.selectEntry(targetEntry, true, true);
        else
            this.scrollToEntry(targetEntry, true, true);
    },


    /**
     * Scroll entry into view. If the entry is taller than the height of the screen,
     * the scroll position is aligned with the top of the entry, otherwise the entry
     * is positioned depending on aCentre parameter.
     *
     * @param aEntry
     *        ID of entry to scroll to.
     * @param aCentre
     *        TRUE to position the entry in the middle of the screen, FALSE to only
     *        scroll it into view.
     * @param aSmooth
     *        Set to TRUE to scroll smoothly, FALSE to jump directly to the
     *        target position.
     */
    scrollToEntry: function FeedView_scrollToEntry(aEntry, aCentre, aSmooth) {
        let win = this.window;
        let entryView = this.getEntryView(aEntry);
        let targetPosition;

        if (entryView.height >= win.innerHeight) {
            targetPosition = entryView.offsetTop;
        }
        else if (aCentre) {
            let difference = win.innerHeight - entryView.height;
            targetPosition = entryView.offsetTop - Math.floor(difference / 2);
        }
        else {
            targetPosition = (entryView.offsetTop + entryView.height) - win.innerHeight;
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

        let distance = aTargetPosition - this.window.pageYOffset;
        let jumpCount = Math.exp(Math.abs(distance) / 400) + 6;
        jumpCount = Math.max(jumpCount, 7);
        jumpCount = Math.min(jumpCount, 15);

        let jump = Math.round(distance / jumpCount);

        this._scrolling = setInterval(function() {
            // If we are within epsilon smaller or equal to the jump,
            // then scroll directly to the target position.
            if (Math.abs(aTargetPosition - this.window.pageYOffset) <= Math.abs(jump)) {
                this.window.scroll(this.window.pageXOffset, aTargetPosition)
                this._stopSmoothScrolling();

                // One more scroll event will be sent but _scrolling is already null,
                // so the event handler will try to automatically select the central
                // entry. This has to be prevented, because it may deselect the entry
                // that the user has just selected manually.
                this._ignoreNextScrollEvent = true;
            }
            else {
                this.window.scroll(this.window.pageXOffset, this.window.pageYOffset + jump);
            }
        }.bind(this), 10)
    },

    _stopSmoothScrolling: function FeedView__stopSmoothScrolling() {
        clearInterval(this._scrolling);
        this._scrolling = null;
    },

    // Return the entry element closest to the middle of the screen.
    getEntryInScreenCenter: function FeedView_getEntryInScreenCenter() {
        if (!this._loadedEntries.length)
            return null;

        let middleLine = this.window.pageYOffset + Math.round(this.window.innerHeight / 2);

        // Iterate starting from the last entry, because the scroll position is
        // likely to be closer to the end than to the beginning of the page.
        let entries = this._entryViews;
        for (let i = entries.length - 1; i >= 0; i--) {
            if ((entries[i].offsetTop <= middleLine) && (!entries[i + 1] || entries[i + 1].offsetTop > middleLine))
                return entries[i].id;
        }

        return this.lastEntry;
    },

    _autoMarkRead: function FeedView__autoMarkRead() {
        if (PrefCache.autoMarkRead && !PrefCache.showHeadlinesOnly && this.query.read !== false) {
            clearTimeout(this._markVisibleTimeout);
            this._markVisibleTimeout = async(this.markVisibleEntriesRead, 1000, this);
        }
    },

    markVisibleEntriesRead: function FeedView_markVisibleEntriesRead() {
        let winTop = this.window.pageYOffset;
        let winBottom = winTop + this.window.innerHeight;
        let entries = this._entryViews;

        let entriesToMark = [];

        // Iterate starting from the last entry, because the scroll position is
        // likely to be closer to the end than to the beginning of the page.
        for (let i = entries.length - 1; i >= 0; i--) {
            let entryTop = entries[i].offsetTop;
            let id = entries[i].id;
            let wasMarkedUnread = (this._entriesMarkedUnread.indexOf(id) != -1);

            if (entryTop >= winTop && entryTop < winBottom - 50 && !wasMarkedUnread)
                entriesToMark.push(id);
        }

        if (entriesToMark.length)
            new Query(entriesToMark).markEntriesRead(true);
    },


    /**
     * Deactivates the view.
     */
    uninit: function FeedView_uninit() {
        getTopWindow().gBrowser.tabContainer.removeEventListener('TabSelect', this, false);
        this.browser.removeEventListener('load', this, false);
        this.window.removeEventListener('resize', this, false);
        this.document.removeEventListener('click', this, true);
        this.document.removeEventListener('scroll', this, true);
        this.document.removeEventListener('keypress', this, true);

        Storage.removeObserver(this);

        this._stopSmoothScrolling();
        clearTimeout(this._markVisibleTimeout);
    },


    handleEvent: function FeedView_handleEvent(aEvent) {
        // Checking if default action has been prevented helps Brief play nicely with
        // other extensions.
        if (aEvent.getPreventDefault())
            return;

        switch (aEvent.type) {

            // Set up the template page when it's loaded.
            case 'load':
                getElement('feed-view-header').hidden = !this.active;

                if (this.active) {
                    this.document.addEventListener('click', this, true);
                    this.document.addEventListener('scroll', this, true);
                    this.document.addEventListener('keypress', this, true);

                    // Some feeds include scripts that use document.write() which screw
                    // us up, because we insert them dynamically after the page is loaded.
                    document.write = document.writeln = function() { };

                    this.refresh();
                }
                break;

            // Click listener must be attached to the document, not the entry container,
            // in order to catch middle-clicks.
            case 'click':
                let node = aEvent.target;
                while (node) {
                    if (node.classList && node.classList.contains('entry')) {
                        this.getEntryView(parseInt(node.id)).onClick(aEvent);
                        break;
                    }
                    node = node.parentNode;
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
                        this.selectEntry(this.getEntryInScreenCenter());
                    }
                    this._scrollSelectionTimeout = async(selectCentralEntry, 100, this);
                }

                this._fillWindow(WINDOW_HEIGHTS_LOAD);
                break;

            case 'resize':
                this._fillWindow(WINDOW_HEIGHTS_LOAD);
                break;

            case 'keypress':
                onKeyPress(aEvent);
                break;

            case 'TabSelect':
                if (this._refreshPending && aEvent.originalTarget == getTopWindow().Brief.getBriefTab()) {
                    this.refresh();
                    this._refreshPending = false;
                }
                break;
        }
    },

    onEntriesAdded: function FeedView_onEntriesAdded(aEntryList) {
        if (getTopWindow().gBrowser.currentURI.spec != document.documentURI) {
            this._refreshPending = true;
            return;
        }

        if (this.active)
            this._onEntriesAdded(aEntryList.IDs);
    },

    onEntriesUpdated: function FeedView_onEntriesUpdated(aEntryList) {
        if (getTopWindow().gBrowser.currentURI.spec != document.documentURI) {
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

        for (let entry in this._loadedEntries.intersect(aEntryList.IDs)) {
            this.getEntryView(entry).read = aNewState;

            if (PrefCache.autoMarkRead && !aNewState)
                this._entriesMarkedUnread.push(entry);
        }
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

        for (let entry in this._loadedEntries.intersect(aEntryList.IDs))
            this.getEntryView(entry).starred = aNewState;
    },

    onEntriesTagged: function FeedView_onEntriesTagged(aEntryList, aNewState, aTag) {
        if (!this.active)
            return;

        for (let entry in this._loadedEntries.intersect(aEntryList.IDs)) {
            let entryView = this.getEntryView(entry);
            let tags = entryView.tags;

            if (aNewState)
                tags.push(aTag);
            else
                tags.splice(tags.indexOf(aTag), 1);

            entryView.tags = tags;
        }

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
     * Checks if given entries belong to the view and inserts them if necessary.
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
        let resume = FeedView__onEntriesAdded.resume;

        let win = this.window;
        if (win.scrollMaxY - win.pageYOffset < win.innerHeight * MIN_LOADED_WINDOW_HEIGHTS) {
            this.refresh()
            return;
        }

        let query = this.getQueryCopy();
        query.startDate = this.getEntryView(this.lastEntry).date;

        this._loadedEntries = yield query.getEntries(resume);

        let newEntries = aAddedEntries.filter(this.containsEntry, this);
        if (newEntries.length) {
            let query = new Query({
                sortOrder: this.query.sortOrder,
                sortDirection: this.query.sortDirection,
                entries: newEntries
            })

            for (let entry in yield query.getFullEntries(resume))
                this._insertEntry(entry, this.getEntryIndex(entry.id));

            this._setEmptyViewMessage();
        }
    }.gen(),

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
        let containedEntries = aRemovedEntries.filter(this.containsEntry, this);
        if (!containedEntries.length)
            return;

        let indices = containedEntries.map(this.getEntryIndex, this);

        // Removing content may cause a scroll event, which should be ignored.
        this._ignoreNextScrollEvent = true;
        getTopWindow().StarUI.panel.hidePopup();

        // If the selected entry is being removed, remember its index.
        let selectedEntryIndex = -1;

        if (indices.length == 1 && aAnimate) {
            let entryID = this._loadedEntries[indices[0]];

            if (entryID == this.selectedEntry) {
                this.selectEntry(null);
                selectedEntryIndex = indices[0];
            }

            this.getEntryView(entryID).remove(true, function() {
                this._loadedEntries.splice(indices[0], 1);
                this._entryViews.splice(indices[0], 1);

                this._afterEntriesRemoved(aLoadNewEntries, selectedEntryIndex);
            }.bind(this))
        }
        else {
            indices.sort(function(a, b) a - b);

            // Start from the oldest entry so that we don't change the relative
            // insertion positions of consecutive entries.
            for (let i = indices.length - 1; i >= 0; i--) {
                if (this._loadedEntries[indices[i]] == this.selectedEntry) {
                    this.selectEntry(null);
                    selectedEntryIndex = indices[i];
                }

                this.getEntryView(this._loadedEntries[indices[i]]).remove();

                this._loadedEntries.splice(indices[i], 1);
                this._entryViews.splice(indices[i], 1);
            }

            this._afterEntriesRemoved(aLoadNewEntries, selectedEntryIndex);
        }
    },

    _afterEntriesRemoved: function FeedView__afterEntriesRemoved(aLoadNewEntries,
                                                                 aPrevSelectedIndex) {
        if (aLoadNewEntries)
            this._fillWindow(WINDOW_HEIGHTS_LOAD, finish.bind(this));
        else
            finish.call(this);

        function finish() {
            this._setEmptyViewMessage();

            if (this._loadedEntries.length && aPrevSelectedIndex != -1) {
                let newSelection = this._loadedEntries[aPrevSelectedIndex] || this.lastEntry;
                this.selectEntry(newSelection);
            }
        }
    },

    /**
     * Refreshes the feed view. Removes the old content and builds the new one.
     */
    refresh: function FeedView_refresh() {
        if (!this.active)
            return;

        // Clean up.
        this._stopSmoothScrolling();
        clearTimeout(this._markVisibleTimeout);
        getTopWindow().StarUI.panel.hidePopup();

        // Manually reset the scroll position, otherwise weird stuff happens.
        if (this.window.pageYOffset != 0) {
            this.window.scroll(this.window.pageXOffset, 0);
            this._ignoreNextScrollEvent = true;
        }

        // Clear the old entries.
        this._loadedEntries = [];
        this._entryViews = [];
        this.document.body.removeChild(this.feedContent);
        let content = this.document.createElement('div');
        content.id = 'feed-content';
        this.document.body.appendChild(content);

        // Prevent the message from briefly showing up before entries are loaded.
        this.document.getElementById('message-box').style.display = 'none';

        this._buildHeader();

        this.headlinesMode = PrefCache.showHeadlinesOnly;

        if (!this.query.feeds || this.query.feeds.length > 1)
            this.document.body.classList.add('multiple-feeds');
        else
            this.document.body.classList.remove('multiple-feeds');

        if (this.headlinesMode)
            this.document.body.classList.add('headlines-mode');
        else
            this.document.body.classList.remove('headlines-mode');

        // Temporarily remove the listener because reading window.innerHeight
        // can trigger a resize event (!?).
        this.window.removeEventListener('resize', this, false);

        this._fillWindow(INITIAL_WINDOW_HEIGHTS_LOAD, function() {
            // Resize events can be dispatched asynchronously, so this listener shouldn't
            // be added earlier along with other ones, because then it could be triggered
            // before the initial refresh.
            this.window.addEventListener('resize', this, false);

            this._setEmptyViewMessage();
            this._autoMarkRead();

            if (PrefCache.entrySelectionEnabled) {
                let lastSelectedEntry = this.selectedEntry;
                this.selectedEntry = null;
                let entry = this.containsEntry(lastSelectedEntry) ? lastSelectedEntry
                                                                  : this._loadedEntries[0];
                this.selectEntry(entry, true);
            }
        }.bind(this))
    },


    /**
     * Loads more entries if the loaded entries don't fill the specified minimal
     * number of window heights ahead of the current scroll position.
     *
     * @param aWindowHeights
     *        The number of window heights to fill ahead of the current scroll
     *        position.
     */
    _fillWindow: function FeedView__fillWindow(aWindowHeights, aCallback) {
        let resume = FeedView__fillWindow.resume;

        if (this._loadingEntries || this.enoughEntriesPreloaded && !this.lastEntryInCenter) {
            if (aCallback)
                aCallback();
            return;
        }

        let stepSize = PrefCache.showHeadlinesOnly ? HEADLINES_LOAD_STEP_SIZE
                                                   : LOAD_STEP_SIZE;

        do var loadedCount = yield this._loadEntries(stepSize, resume);
        while (loadedCount && (!this.enoughEntriesPreloaded || this.lastEntryInCenter))

        if (aCallback)
            aCallback();
    }.gen(),

    get lastEntryInCenter() {
        return this.getEntryInScreenCenter() == this.lastEntry;
    },

    get enoughEntriesPreloaded() {
        return this.window.scrollMaxY - this.window.pageYOffset >
               this.window.innerHeight * MIN_LOADED_WINDOW_HEIGHTS;
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
    _loadEntries: function FeedView__loadEntries(aCount, aCallback) {
        let resume = FeedView__loadEntries.resume;

        this._loadingEntries = true;
        let loadedEntries = null;

        let dateQuery = this.getQueryCopy();
        let edgeDate = undefined;

        if (this._loadedEntries.length) {
            let lastEntryDate = this.getEntryView(this.lastEntry).date;
            if (dateQuery.sortDirection == Query.prototype.SORT_DESCENDING)
                edgeDate = lastEntryDate - 1;
            else
                edgeDate = lastEntryDate + 1;
        }

        if (dateQuery.sortDirection == Query.prototype.SORT_DESCENDING)
            dateQuery.endDate = edgeDate;
        else
            dateQuery.startDate = edgeDate;

        dateQuery.limit = aCount;

        let dates = yield dateQuery.getProperty('date', false, resume);
        if (dates.length) {
            let query = this.getQueryCopy();
            if (query.sortDirection == Query.prototype.SORT_DESCENDING) {
                query.startDate = dates[dates.length - 1];
                query.endDate = edgeDate;
            }
            else {
                query.startDate = edgeDate;
                query.endDate = dates[dates.length - 1];
            }

            loadedEntries = yield query.getFullEntries(resume);
            for (let entry in loadedEntries) {
                this._insertEntry(entry, this._loadedEntries.length);
                this._loadedEntries.push(entry.id);
            }
        }

        this._loadingEntries = false;

        aCallback(loadedEntries ? loadedEntries.length : 0);
    }.gen(),

    _insertEntry: function FeedView__insertEntry(aEntryData, aPosition) {
        let entryView = new EntryView(this, aEntryData, this.headlinesMode);

        let nextEntry = this.feedContent.childNodes[aPosition];
        this.feedContent.insertBefore(entryView.container, nextEntry);

        this._entryViews.splice(aPosition, 0, entryView);
    },

    _buildHeader: function FeedView__buildHeader() {
        let feedTitle = getElement('feed-title');
        feedTitle.removeAttribute('href');
        feedTitle.className = '';
        feedTitle.textContent = this.titleOverride || this.title;

        let feed = Storage.getFeed(this.query.feeds);
        if (feed) {
            let url = feed.websiteURL || feed.feedURL;
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

            feedTitle.setAttribute('tooltiptext', feed.subtitle);
        }
    },

    _setEmptyViewMessage: function FeedView__setEmptyViewMessage() {
        let messageBox = this.document.getElementById('message-box');
        if (this._loadedEntries.length) {
            messageBox.style.display = 'none';
            return;
        }

        let mainMessage = '', secondaryMessage = '';

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
    }

}


const DEFAULT_FAVICON_URL = 'chrome://brief/skin/icons/feed-favicon.png';

function EntryView(aFeedView, aEntryData, aHeadline) {
    this.feedView = aFeedView;
    this.headline = aHeadline;

    this.id = aEntryData.id;
    this.date = aEntryData.date;
    this.entryURL = aEntryData.entryURL;
    this.updated = aEntryData.updated;

    this.container = this.feedView.document.getElementById('article-template').cloneNode(true);
    this.container.id = aEntryData.id;
    this.container.classList.add(this.headline ? 'headline' : 'full');

    this.read = aEntryData.read;
    this.starred = aEntryData.starred;
    this.tags = aEntryData.tags ? aEntryData.tags.split(', ') : [];

    let feed = Storage.getFeed(aEntryData.feedID);

    let controls = this._getElement('controls');
    if (this.feedView.query.deleted == Storage.ENTRY_STATE_TRASHED)
        controls.removeChild(this._getElement('delete'));
    else
        controls.removeChild(this._getElement('restore'));

    let titleElem = this._getElement('title-link');
    if (aEntryData.entryURL)
        titleElem.setAttribute('href', aEntryData.entryURL);

    // Use innerHTML instead of textContent to resolve entities.
    titleElem.innerHTML = aEntryData.title || aEntryData.entryURL;

    this._getElement('feed-name').innerHTML = feed.title;
    this._getElement('authors').innerHTML = aEntryData.authors;
    this._getElement('date').innerHTML = this._constructDate();

    if (this.headline) {
        this.collapse(false);

        if (aEntryData.entryURL)
            this._getElement('headline-link').setAttribute('href', aEntryData.entryURL);

        this._getElement('headline-title').innerHTML = aEntryData.title || aEntryData.entryURL;
        this._getElement('headline-title').setAttribute('title', aEntryData.title);
        this._getElement('headline-feed-name').textContent = feed.title;

        let favicon = (feed.favicon != 'no-favicon') ? feed.favicon : DEFAULT_FAVICON_URL;
        this._getElement('feed-icon').src = favicon;

        async(function() {
            this._getElement('content').innerHTML = aEntryData.content;

            if (this.feedView.query.searchString)
                this._highlightSearchTerms(this._getElement('headline-title'));
        }.bind(this))
    }
    else {
        this._getElement('content').innerHTML = aEntryData.content;

        if (this.feedView.query.searchString) {
            async(function() {
                for (let elem in ['authors', 'tags', 'title', 'content'])
                    this._highlightSearchTerms(this._getElement(elem));

                this._searchTermsHighlighted = true;
            }.bind(this));
        }
    }
}

EntryView.prototype = {

    get read() {
        return this.__read;
    },
    set read(aValue) {
        this.__read = aValue;

        if (aValue) {
            this.container.classList.add('read');
            this._getElement('mark-read').textContent = this._strings.markAsUnread;

            if (this.updated) {
                this.updated = false;
                this._getElement('date').innerHTML = this._constructDate();
            }
        }
        else {
            this.container.classList.remove('read');
            this._getElement('mark-read').textContent = this._strings.markAsRead;
        }
    },


    get starred() {
        return this.__starred;
    },
    set starred(aValue) {
        this.__starred = aValue;

        if (aValue)
            this.container.classList.add('starred');
        else
            this.container.classList.remove('starred');
    },


    get tags() {
        return this.__tags;
    },
    set tags(aValue) {
        this.__tags = aValue;
        this._getElement('tags').textContent = aValue.sort().join(', ');
    },


    __collapsed: false,

    get collapsed() {
        return this.__collapsed;
    },


    set selected(aValue) {
        if (aValue)
            this.container.classList.add('selected');
        else
            this.container.classList.remove('selected');
    },


    get offsetTop() {
        return this.container.offsetTop;
    },

    get height() {
        return this.container.offsetHeight;
    },


    remove: function EntryView_remove(aAnimate, aCallback) {
        if (aAnimate) {
            this.container.addEventListener('transitionend', function() {
                // The element may have been removed in the meantime
                // if the view had been refreshed.
                if (this.container.parentNode == this.feedView.feedContent) {
                    this.feedView.feedContent.removeChild(this.container);
                    aCallback();
                }
            }.bind(this), true);

            this.container.setAttribute('removing', true);
        }
        else {
            this.feedView.feedContent.removeChild(this.container);
        }
    },

    collapse: function EntryView_collapse(aAnimate) {
        if (this.collapsed)
            return;

        this.container.classList.add('collapsed');
        if (this.container.previousSibling)
            this.container.previousSibling.classList.remove('next-expanded');

        showElement(this._getElement('headline-container'));

        hideElement(this._getElement('full-container'), aAnimate, function() {
            let controls = this._getElement('controls');
            this._getElement('headline-container').appendChild(controls);
        }.bind(this))

        this.__collapsed = true;
    },

    expand: function EntryView_expand(aAnimate) {
        if (!this.collapsed)
            return;

        this.container.classList.remove('collapsed');
        if (this.container.previousSibling)
            this.container.previousSibling.classList.add('next-expanded');

        let controls = this._getElement('controls');
        this._getElement('header').appendChild(controls);

        hideElement(this._getElement('headline-container'));

        showElement(this._getElement('full-container'), aAnimate, function() {
            if (this.container.parentNode != this.feedView.feedContent)
                return;

            if (PrefCache.autoMarkRead && this.feedView.query.read !== false)
                Commands.markEntryRead(this.id, true);

            if (this.id == this.feedView.selectedEntry) {
                let entryBottom = this.offsetTop + this.height;
                let screenBottom = this.feedView.window.pageYOffset +
                                   this.feedView.window.innerHeight;
                if (entryBottom > screenBottom)
                    this.feedView.scrollToEntry(this.id, false, true);
            }
        }.bind(this))


        if (this.feedView.query.searchString && !this._searchTermsHighlighted) {
            for (let elem in ['authors', 'tags', 'title', 'content'])
                this._highlightSearchTerms(this._getElement(elem));

            this._searchTermsHighlighted = true;
        }

        this.__collapsed = false;
    },

    onClick: function EntryView_onClick(aEvent) {
        if (PrefCache.entrySelectionEnabled)
            this.feedView.selectEntry(this.id);

        // Walk the parent chain of the even target to check if an anchor was clicked.
        let anchor = null;
        let element = aEvent.target;
        while (element != this.container) {
            if (element.localName.toUpperCase() == 'A') {
                anchor = element;
                break;
            }
            element = element.parentNode;
        }

        // Divert links to new tabs according to user preferences.
        if (anchor && (aEvent.button == 0 || aEvent.button == 1)) {
            aEvent.preventDefault();

            // preventDefault doesn't stop the default action for middle-clicks,
            // so we've got stop propagation as well.
            if (aEvent.button == 1)
                aEvent.stopPropagation();

            let openInTabs = Prefs.getBoolPref('feedview.openEntriesInTabs');
            let newTab = openInTabs || aEvent.button == 1 || aEvent.ctrlKey;

            if (anchor.getAttribute('command') == 'open') {
                Commands.openEntryLink(this.id, newTab);
                return;
            }
            else if (anchor.hasAttribute('href')) {
                Commands.openLink(anchor.getAttribute('href'), newTab);
                return;
            }
        }

        let command = aEvent.target.getAttribute('command');

        if (aEvent.detail == 2 && PrefCache.doubleClickMarks && !command)
            Commands.markEntryRead(this.id, !this.read);

        switch (command) {
            case 'switchRead':
                Commands.markEntryRead(this.id, !this.read);
                break;

            case 'star':
                if (this.starred) {
                    let query = new Query(this.id);

                    query.verifyBookmarksAndTags();

                    query.getProperty('bookmarkID', false, function(ids) {
                        let starElem = this._getElement('article-star');
                        getTopWindow().StarUI.showEditBookmarkPopup(ids[0], starElem, 'after_start');
                    }.bind(this))
                }
                else {
                    Commands.starEntry(this.id, true);
                }
                break;

            case 'delete':
                Commands.deleteEntry(this.id);
                break;

            case 'restore':
                Commands.restoreEntry(this.id);
                break;

            default:
                if (aEvent.button != 0)
                    return;

                if (this.collapsed) {
                    this.expand(true);
                }
                else {
                    let className = aEvent.target.className;
                    if ((className == 'header' || className == 'title')
                            && PrefCache.showHeadlinesOnly) {
                        this.collapse(true);
                    }
                }
        }
    },

    _getElement: function EntryView__getElement(aClassName) {
        return this.container.getElementsByClassName(aClassName)[0];
    },

    _constructDate: function EntryView__constructDate() {
        let entryDate = new Date(this.date);
        let entryTime = entryDate.getTime() - entryDate.getTimezoneOffset() * 60000;

        let now = new Date();
        let nowTime = now.getTime() - now.getTimezoneOffset() * 60000;

        let today = Math.ceil(nowTime / 86400000);
        let entryDay = Math.ceil(entryTime / 86400000);
        let deltaDays = today - entryDay;
        let deltaYears = Math.ceil(today / 365) - Math.ceil(entryDay / 365);

        let string = '';
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

        if (this.updated)
            string += ' <span class="updated">' + this._strings.entryUpdated + '</span>';

        return string;
    },

    _highlightSearchTerms: function EntryView__highlightSearchTerms(aElement) {
        for (let term in this.feedView.query.searchString.match(/[A-Za-z0-9]+/g)) {
            let searchRange = this.feedView.document.createRange();
            searchRange.setStart(aElement, 0);
            searchRange.setEnd(aElement, aElement.childNodes.length);

            let startPoint = this.feedView.document.createRange();
            startPoint.setStart(aElement, 0);
            startPoint.setEnd(aElement, 0);

            let endPoint = this.feedView.document.createRange();
            endPoint.setStart(aElement, aElement.childNodes.length);
            endPoint.setEnd(aElement, aElement.childNodes.length);

            let baseNode = this.feedView.document.createElement('span');
            baseNode.className = 'search-highlight';

            let retRange = Finder.Find(term, searchRange, startPoint, endPoint);
            while (retRange) {
                let surroundingNode = baseNode.cloneNode(false);
                surroundingNode.appendChild(retRange.extractContents());

                let before = retRange.startContainer.splitText(retRange.startOffset);
                before.parentNode.insertBefore(surroundingNode, before);

                startPoint.setStart(surroundingNode, surroundingNode.childNodes.length);
                startPoint.setEnd(surroundingNode, surroundingNode.childNodes.length);

                retRange = Finder.Find(term, searchRange, startPoint, endPoint)
            }
        }
    },

    get _strings() {
        delete this.__proto__._strings;
        return this.__proto__._strings = {
            today:        gStringBundle.getString('today'),
            yesterday:    gStringBundle.getString('yesterday'),
            entryUpdated: gStringBundle.getString('entryWasUpdated'),
            markAsRead:   gStringBundle.getString('markEntryAsRead'),
            markAsUnread: gStringBundle.getString('markEntryAsUnread')
        }
    }

}


function hideElement(aElement, aAnimate, aCallback) {
    if (!aAnimate) {
        aElement.style.display = 'none';
        aElement.style.height = '0';
        aElement.style.opacity = '0';

        if (aCallback)
            aCallback();
        return;
    }

    // CSS transitions don't work with height: auto.
    let win = aElement.ownerDocument.defaultView;
    let naturalHeight = win.getComputedStyle(aElement).getPropertyValue('height');
    aElement.style.height = naturalHeight;
    aElement.offsetHeight; // Force reflow.

    aElement.style.height = '0';
    aElement.style.opacity = '0';

    aElement.setAttribute('hiding', true);
    aElement.addEventListener('transitionend', listener, false);

    function listener() {
        aElement.removeAttribute('hiding');
        aElement.removeEventListener('transitionend', listener, false);

        aElement.style.display = 'none';

        if (aCallback)
            aCallback();
    }
}

function showElement(aElement, aAnimate, aCallback) {
    if (!aAnimate) {
        aElement.style.display = '';
        aElement.style.height = '';
        aElement.style.opacity = '';

        if (aCallback)
            aCallback();
        return;
    }

    aElement.style.display = '';

    // CSS transitions don't work with height: auto. For a workaround,
    // temporarily set height: auto and read the actual computed height...
    aElement.style.height = '';
    aElement.offsetHeight; // Force reflow.

    let win = aElement.ownerDocument.defaultView;
    let naturalHeight = win.getComputedStyle(aElement).getPropertyValue('height');

    // Set the height back to 0...
    aElement.style.height = '0';
    aElement.offsetHeight; // Force reflow.

    // Finally, transition the height to the previously computed value.
    aElement.style.height = naturalHeight;
    aElement.style.opacity = '';

    aElement.setAttribute('showing', true);
    aElement.addEventListener('transitionend', listener, false);

    function listener() {
        aElement.removeAttribute('showing');
        aElement.removeEventListener('transitionend', listener, false);

        // However, the natural height isn't always exactly right so after the
        // transition is finished, we set the height back to auto.
        aElement.style.height = '';

        if (aCallback)
            aCallback();
    }
}

__defineGetter__('Finder', function() {
    let finder = Cc['@mozilla.org/embedcomp/rangefind;1'].createInstance(Ci.nsIFind);
    finder.caseSensitive = false;

    delete this.Finder;
    return this.Finder = finder;
})

__defineGetter__('gSecurityManager', function() {
    delete this.gSecurityManager;
    return this.gSecurityManager = Cc['@mozilla.org/scriptsecuritymanager;1']
                                   .getService(Ci.nsIScriptSecurityManager);
})

__defineGetter__('gBriefPrincipal', function() {
    let uri = NetUtil.newURI(document.documentURI);
    let resolvedURI = Cc['@mozilla.org/chrome/chrome-registry;1']
                      .getService(Ci.nsIChromeRegistry)
                      .convertChromeURL(uri);

    delete this.gBriefPrincipal;
    return this.gBriefPrincipal = gSecurityManager.getCodebasePrincipal(resolvedURI);
})
