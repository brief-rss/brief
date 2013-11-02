// Minimal number of window heights worth of entries loaded ahead of the
// current scrolling position at any given time.
const MIN_LOADED_WINDOW_HEIGHTS = 1;

// Number of window heights worth of entries to load when the above threshold is crossed.
const WINDOW_HEIGHTS_LOAD = 2;

// Number of window heights worth of entries to load initially when refreshing a view.
const INITIAL_WINDOW_HEIGHTS_LOAD = 1;

// Number of entries queried in each step until they fill the defined height.
const LOAD_STEP_SIZE = 5;

// Same as above, but applies to headlines view.
const HEADLINES_LOAD_STEP_SIZE = 25;

/**
 * Manages the display of feed content.
 *
 * @param aTitle
 *        Title of the view which will be shown in the header.
 * @param aQuery
 *        Query that selects entries contained by the view.
 */
function FeedView(aTitle, aQuery) {
    this.title = aTitle;
    this._fixedUnread = aQuery.read !== undefined;
    this._fixedStarred = aQuery.starred !== undefined || aQuery.tags !== undefined;

    for (let id of ['show-all-entries-checkbox', 'filter-unread-checkbox', 'filter-starred-checkbox'])
        getElement(id).hidden = this._fixedStarred || this._fixedUnread;

    aQuery.sortOrder = Query.prototype.SORT_BY_DATE;
    this.__query = aQuery;

    this._entriesMarkedUnread = [];

    if (gCurrentView)
        gCurrentView.uninit();

    let singleFeed = this.query.feeds && this.query.feeds.length == 1;
    let trash = this.query.deleted == Storage.ENTRY_STATE_TRASHED;
    if (singleFeed || trash)
        getElement('view-title-button').setAttribute('contextOptions', true);
    else
        getElement('view-title-button').removeAttribute('contextOptions');

    getElement('feed-view-header').removeAttribute('border');

    if (!this.query.searchString)
        getElement('searchbar').value = '';

    getTopWindow().gBrowser.tabContainer.addEventListener('TabSelect', this, false);

    Storage.addObserver(this);

    this.document.addEventListener('click', this, true);
    this.document.addEventListener('scroll', this, true);
    this.document.addEventListener('keypress', this, true);

    this.refresh();
}


FeedView.prototype = {

    title: '',

    titleOverride: '',

    get headlinesMode() {
        let feedIDs = this.query.feeds || this.query.folders;
        if (feedIDs && feedIDs.length == 1)
            var viewMode = Storage.getFeed(feedIDs[0]).viewMode;
        else
            viewMode = PrefCache.viewMode;

        return viewMode == 1;
    },

    get selectedEntry() this.__selectedEntry || null,

    // Ordered list of EntryView objects of entries that have been loaded.
    entryViews: [],

    // Ordered list of IDs of entries that have been loaded.
    _loadedEntries: [],

    _refreshPending: false,

    // Indicates if entries are being loaded (i.e. they have been queried and
    // the view is waiting to insert the results).
    _loading: false,

    // Note that because we don't refresh more than absolutely necessary in
    // _onEntriesAdded, we don't strictly track whether all entries have been loaded. This
    // flag is set conservatively, i.e. it is true only if we know for sure all entries
    // have been loaded, but it is false if there *could* be more.
    _allEntriesLoaded: false,

    // ID of the animation interval if the view is being scrolled, or null otherwise.
    _scrolling: null,

    // Indicates if a filter paramater is fixed and cannot be toggled by the user.
    _fixedUnread: false,
    _fixedStarred: false,


    get browser() getElement('feed-view'),

    get document() this.browser.contentDocument,

    get window() this.document.defaultView,

    get feedContent() this.document.getElementById('feed-content'),


    getEntryIndex: function(aEntry) this._loadedEntries.indexOf(aEntry),

    getEntryView:  function(aEntry) this._entryViews[this.getEntryIndex(aEntry)],

    isEntryLoaded: function(aEntry) this.getEntryIndex(aEntry) !== -1,

    get lastLoadedEntry() this._loadedEntries[this._loadedEntries.length - 1],


    // Query that selects all entries contained by the view.
    get query() {
        if (!this._fixedUnread)
            this.__query.read = PrefCache.filterUnread ? false : undefined;
        if (!this._fixedStarred)
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

        let selectedIndex = this.getEntryIndex(this.selectedEntry);
        let nextEntry = this._loadedEntries[selectedIndex + 1];
        if (nextEntry)
            this.selectEntry(nextEntry, true, true);
    },

    selectPrevEntry: function FeedView_selectPrevEntry() {
        if (this._scrolling)
            return;

        let selectedIndex = this.getEntryIndex(this.selectedEntry);
        let prevEntry = this._loadedEntries[selectedIndex - 1];
        if (prevEntry)
            this.selectEntry(prevEntry, true, true);
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
        if (this.selectedEntry)
            this.getEntryView(this.selectedEntry).selected = false;

        this.__selectedEntry = aEntry;

        if (aEntry) {
            this.getEntryView(aEntry).selected = true;

            if (aScroll)
                this.scrollToEntry(aEntry, true, aScrollSmoothly, true);
        }
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
     * @param aSuppressSelection
     *        Set to TRUE to prevent scrolling from altering selection.
     */
    scrollToEntry: function FeedView_scrollToEntry(aEntry, aCentre, aSmooth, aSuppressSelection) {
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

        this.scroll(targetPosition, aSmooth, aSuppressSelection);
    },

    // Scroll down by the height of the viewport.
    scrollDownByScreen: function FeedView_scrollDownByScreen() {
        this.scroll(this.window.pageYOffset + this.window.innerHeight - 20, true);
    },

    // See scrollUpByScreen.
    scrollUpByScreen: function FeedView_scrollUpByScreen() {
        this.scroll(this.window.pageYOffset - this.window.innerHeight + 20, true);
    },

    /**
     * Scrolls smoothly to the given position
     *
     * @param aTargetPosition
     *        Y coordinate with which to line up the top edge of the viewport.
     * @param aSmooth
     *        Set to TRUE to scroll smoothly, FALSE to jump directly to the
     *        target position.
     * @param aSuppressSelection
     *        Set to TRUE to prevent scrolling from altering selection.
     */
    scroll: function FeedView_scroll(aTargetPosition, aSmooth, aSuppressSelection) {
        if (this._scrolling)
            return;

        // Clamp the target position.
        let targetPosition = Math.max(aTargetPosition, 0);
        targetPosition = Math.min(targetPosition, this.window.scrollMaxY);

        if (targetPosition == this.window.pageYOffset)
            return;

        if (aSmooth && Services.prefs.getBoolPref('general.smoothScroll')) {
            let distance = targetPosition - this.window.pageYOffset;
            let jumpCount = Math.exp(Math.abs(distance) / 400) + 6;
            jumpCount = Math.max(jumpCount, 7);
            jumpCount = Math.min(jumpCount, 15);

            let jump = Math.round(distance / jumpCount);

            this._scrolling = setInterval(() => {
                // If we are within epsilon smaller or equal to the jump,
                // then scroll directly to the target position.
                if (Math.abs(targetPosition - this.window.pageYOffset) <= Math.abs(jump)) {
                    this.window.scroll(this.window.pageXOffset, targetPosition)
                    this._stopSmoothScrolling();

                    // One more scroll event will be sent but _scrolling is already null,
                    // so the event handler will try to automatically select the central entry.
                    if (aSuppressSelection)
                        this._suppressSelectionOnNextScroll = true;
                }
                else {
                    this.window.scroll(this.window.pageXOffset, this.window.pageYOffset + jump);
                }
            }, 10)
        }
        else {
            if (aSuppressSelection)
                this._suppressSelectionOnNextScroll = true;

            this.window.scroll(this.window.pageXOffset, targetPosition);
        }
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

        return this.lastLoadedEntry;
    },

    _autoMarkRead: function FeedView__autoMarkRead() {
        if (PrefCache.autoMarkRead && !this.headlinesMode && this.query.read !== false) {
            clearTimeout(this._markVisibleTimeout);
            let callback = this._callbackRefreshGuard(this.markVisibleEntriesRead.bind(this));
            this._markVisibleTimeout = setTimeout(callback, 500);
        }
    },

    // Array of entries manually marked as unread by the user. They won't be
    // marked as read again when autoMarkRead is on.
    _entriesMarkedUnread: [],

    markVisibleEntriesRead: function FeedView_markVisibleEntriesRead() {
        let winTop = this.window.pageYOffset;
        let winBottom = winTop + this.window.innerHeight;
        let entries = this._entryViews;

        let entriesToMark = [];

        // Iterate starting from the last entry, because scroll position is
        // likely to be closer to the end than to the beginning of the page
        // when a lot of entries are loaded.
        for (let i = entries.length - 1; i >= 0; i--) {
            if (this._entriesMarkedUnread.indexOf(entries[i].id) != -1)
                continue;

            let entryTop = entries[i].offsetTop;
            let entryBottom = entryTop + entries[i].height;

            if (entryTop >= winTop && (entryBottom < winBottom || entryTop < winBottom - 200))
                entriesToMark.push(entries[i].id);
        }

        if (entriesToMark.length)
            new Query(entriesToMark).markEntriesRead(true);
    },


    uninit: function FeedView_uninit() {
        getTopWindow().gBrowser.tabContainer.removeEventListener('TabSelect', this, false);
        this.window.removeEventListener('resize', this, false);
        this.document.removeEventListener('click', this, true);
        this.document.removeEventListener('scroll', this, true);
        this.document.removeEventListener('keypress', this, true);

        Storage.removeObserver(this);

        this._stopSmoothScrolling();
    },


    handleEvent: function FeedView_handleEvent(aEvent) {
        // Checking if default action has been prevented helps Brief play nice with
        // other extensions.
        if (aEvent.defaultPrevented)
            return;

        switch (aEvent.type) {

            // Click listener must be attached to the document, not the entry container,
            // in order to catch middle-clicks.
            case 'click':
                let node = aEvent.target;
                let target = null;
                while (node) {
                    if (node.classList && node.classList.contains('entry'))
                        target = node;

                    node = node.parentNode;
                }

                if (target)
                    this.getEntryView(parseInt(target.id)).onClick(aEvent);
                break;

            case 'scroll':
                this._autoMarkRead();

                if (this.window.pageYOffset > 0)
                    getElement('feed-view-header').setAttribute('border', true);
                else
                    getElement('feed-view-header').removeAttribute('border');

                if (this._suppressSelectionOnNextScroll) {
                    this._suppressSelectionOnNextScroll = false;
                }
                else if (!this._scrolling) {
                    clearTimeout(this._scrollSelectionTimeout);
                    let callback = this._callbackRefreshGuard(() =>
                        this.selectEntry(this.getEntryInScreenCenter())
                    )
                    this._scrollSelectionTimeout = setTimeout(callback, 50);
                }

                if (!this.enoughEntriesPreloaded(MIN_LOADED_WINDOW_HEIGHTS))
                    this._fillWindow(WINDOW_HEIGHTS_LOAD);
                break;

            case 'resize':
                if (!this.enoughEntriesPreloaded(MIN_LOADED_WINDOW_HEIGHTS))
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
        if (getTopWindow().gBrowser.currentURI.spec == document.documentURI)
            this._onEntriesAdded(aEntryList.entries);
        else
            this._refreshPending = true;
    },

    onEntriesUpdated: function FeedView_onEntriesUpdated(aEntryList) {
        if (getTopWindow().gBrowser.currentURI.spec == document.documentURI) {
            this._onEntriesRemoved(aEntryList.entries, false, false);
            this._onEntriesAdded(aEntryList.entries);
        }
        else {
            this._refreshPending = true;
        }
    },

    onEntriesMarkedRead: function FeedView_onEntriesMarkedRead(aEntryList, aNewState) {
        if (this.query.read === false) {
            if (aNewState)
                this._onEntriesRemoved(aEntryList.entries, true, true);
            else
                this._onEntriesAdded(aEntryList.entries);
        }

        for (let entry of this._loadedEntries.intersect(aEntryList.entries)) {
            this.getEntryView(entry).read = aNewState;

            if (PrefCache.autoMarkRead && !aNewState)
                this._entriesMarkedUnread.push(entry);
        }
    },

    onEntriesStarred: function FeedView_onEntriesStarred(aEntryList, aNewState) {
        if (this.query.starred === true) {
            if (aNewState)
                this._onEntriesAdded(aEntryList.entries);
            else
                this._onEntriesRemoved(aEntryList.entries, true, true);
        }

        for (let entry of this._loadedEntries.intersect(aEntryList.entries))
            this.getEntryView(entry).starred = aNewState;
    },

    onEntriesTagged: function FeedView_onEntriesTagged(aEntryList, aNewState, aTag) {
        for (let entry of this._loadedEntries.intersect(aEntryList.entries)) {
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
                this._onEntriesAdded(aEntryList.entries);
            else
                this._onEntriesRemoved(aEntryList.entries, true, true);
        }
    },

    onEntriesDeleted: function FeedView_onEntriesDeleted(aEntryList, aNewState) {
        if (aNewState === this.query.deleted)
            this._onEntriesAdded(aEntryList.entries);
        else
            this._onEntriesRemoved(aEntryList.entries, true, true);
    },


    /**
     * Checks if given entries belong to the view and inserts them if necessary.
     *
     * @param aAddedEntries
     *        Array of IDs of entries.
     */
    _onEntriesAdded: function FeedView__onEntriesAdded(aAddedEntries) {
        // The simplest way would be to query the current list of all entries in the view
        // and intersect it with the list of added ones. However, this is expansive for
        // large views and we try to avoid it.
        //
        // If the previously loaded entries satisfy the desired preload amount, the added
        // entries need to be inserted only if they have a more recent date than the last
        // loaded entry. Hence, we can use the date of the last loaded entry as an anchor
        // and determine the current list of entries that should be loaded by selecting
        // entries with a newer date than that anchor.
        if (this.enoughEntriesPreloaded(MIN_LOADED_WINDOW_HEIGHTS)) {
            this._allEntriesLoaded = false;

            let query = this.getQueryCopy();
            let edgeDate = this.getEntryView(this.lastLoadedEntry).date.getTime();

            if (query.sortDirection == Query.prototype.SORT_DESCENDING)
                query.startDate = edgeDate;
            else
                query.endDate = edgeDate;

            this._loadedEntries = yield this._refreshGuard(query.getEntries());

            let newEntries = aAddedEntries.filter(this.isEntryLoaded, this);
            if (newEntries.length) {
                let query = new Query({
                    sortOrder: this.query.sortOrder,
                    sortDirection: this.query.sortDirection,
                    entries: newEntries
                })

                for (let entry of yield query.getFullEntries())
                    this._insertEntry(entry, this.getEntryIndex(entry.id));

                this._setEmptyViewMessage();
            }
        }
        // If the previously loaded entries don't satisfy the desired preload amount,
        // we have no anchor to use the above approach.
        // If all entries in the view have already been loaded it means it's a very
        // small view, so it's cheap to use the simplest solution and just query the
        // current list of all entries.
        // Otherwise, just blow it all away and refresh from scratch.
        else {
            if (this._allEntriesLoaded) {
                let currentEntryList = yield this.query.getEntries();
                if (currentEntryList.intersect(aAddedEntries).length)
                    this.refresh()
            }
            else {
                this.refresh();
            }
        }
    }.task(),

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
        let containedEntries = aRemovedEntries.filter(this.isEntryLoaded, this);
        if (!containedEntries.length)
            return;

        let animate = aAnimate && containedEntries.length < 30;

        // Removing content may cause a scroll event that should be ignored.
        this._suppressSelectionOnNextScroll = true;

        getTopWindow().StarUI.panel.hidePopup();

        let selectedEntryIndex = -1;

        let indices = containedEntries.map(this.getEntryIndex, this)
                                      .sort((a, b) => a - b);

        // Iterate starting from the last entry to avoid changing
        // positions of consecutive entries.
        let removedCount = 0;
        for (let i = indices.length - 1; i >= 0; i--) {
            let entry = this._loadedEntries[indices[i]];

            if (entry == this.selectedEntry) {
                this.selectEntry(null);
                selectedEntryIndex = indices[i];
            }

            let entryView = this.getEntryView(entry);

            let removed = entryView.remove(animate);

            this._refreshGuard(removed).then(() => {
                let index = this.getEntryIndex(entry);
                this._loadedEntries.splice(index, 1);
                this._entryViews.splice(index, 1);

                // The item may have been selected since animation started
                if (this.selectedEntry == entry) {
                    this.__selectedEntry = null;
                }

                if (this.headlinesMode) {
                    let dayHeader = this.document.getElementById('day' + entryView.day);
                    if (!dayHeader.nextSibling || dayHeader.nextSibling.tagName == 'H1')
                        this.feedContent.removeChild(dayHeader);
                }

                if (++removedCount == indices.length) {
                    if (aLoadNewEntries && !this.enoughEntriesPreloaded(MIN_LOADED_WINDOW_HEIGHTS))
                        this._fillWindow(WINDOW_HEIGHTS_LOAD).then(afterEntriesRemoved.bind(this));
                    else
                        afterEntriesRemoved.call(this);
                }
            })
        }

        function afterEntriesRemoved() {
            this._setEmptyViewMessage();

            if (this._loadedEntries.length && selectedEntryIndex != -1) {
                let newSelection = this._loadedEntries[selectedEntryIndex] || this.lastLoadedEntry;
                this.selectEntry(newSelection);
            }
        }
    },

    /**
     * Refreshes the feed view. Removes the old content and builds the new one.
     */
    refresh: function FeedView_refresh() {
        this.viewID = Math.floor(Math.random() * 1000000);

        // Reset view state.
        this._loading = false;
        this._allEntriesLoaded = false;
        this._loadedEntries = [];
        this._entryViews = [];

        this.document.body.classList.remove('headlines-view');
        this.document.body.classList.remove('multiple-feeds');

        this._stopSmoothScrolling();
        getTopWindow().StarUI.panel.hidePopup();

        // Manually reset the scroll position, otherwise weird stuff happens.
        this.scroll(0, false, true);

        // Clear DOM content.
        this.document.body.removeChild(this.feedContent);
        let content = this.document.createElement('div');
        content.id = 'feed-content';
        this.document.body.appendChild(content);

        // Prevent the message from briefly showing up before entries are loaded.
        this.document.getElementById('message-box').style.display = 'none';

        getElement('full-view-checkbox').checked = !this.headlinesMode;
        getElement('headlines-checkbox').checked = this.headlinesMode;

        getElement('view-title-button-label').value = this.titleOverride || this.title;

        if (!this.query.feeds || this.query.feeds.length > 1)
            this.document.body.classList.add('multiple-feeds');

        if (this.headlinesMode)
            this.document.body.classList.add('headlines-view');

        // Temporarily remove the listener because reading window.innerHeight
        // can trigger a resize event (!?).
        this.window.removeEventListener('resize', this, false);

        this._fillWindow(INITIAL_WINDOW_HEIGHTS_LOAD).then(() => {
            // Resize events can be dispatched asynchronously, so this listener shouldn't
            // be added earlier along with other ones, because then it could be triggered
            // before the initial refresh.
            this.window.addEventListener('resize', this, false);

            this._setEmptyViewMessage();
            this._autoMarkRead();

            let lastSelectedEntry = this.selectedEntry;
            this.__selectedEntry = null;
            if (lastSelectedEntry != this._loadedEntries[0] && this.isEntryLoaded(lastSelectedEntry))
                this.selectEntry(lastSelectedEntry, true);
            else
                this.selectEntry(this._loadedEntries[0], false);
        })
    },


    /**
     * Loads more entries if the loaded entries don't fill the specified minimal
     * number of window heights ahead of the current scroll position.
     *
     * @param aWindowHeights
     *        The number of window heights to fill ahead of the current scroll
     *        position.
     * @returns Promise<null>
     */
    _fillWindow: function FeedView__fillWindow(aWindowHeights) {
        if (!this._loading && !this._allEntriesLoaded && !this.enoughEntriesPreloaded(aWindowHeights)) {
            let stepSize = this.headlinesMode ? HEADLINES_LOAD_STEP_SIZE
                                              : LOAD_STEP_SIZE;
            do var loadedCount = yield this._refreshGuard(this._loadEntries(stepSize))
            while (loadedCount && !this.enoughEntriesPreloaded(aWindowHeights))
        }
    }.task(),

    /**
     * Checks if enough entries have been loaded.
     *
     * @param aWindowHeights
     *        See FeedView.fillWindow().
     */
    enoughEntriesPreloaded: function FeedView__enoughEntriesPreloaded(aWindowHeights) {
        return this.window.scrollMaxY - this.window.pageYOffset >
               this.window.innerHeight * aWindowHeights
               && this.getEntryInScreenCenter() != this.lastLoadedEntry;
    },

    /**
     * Queries and appends a requested number of entries. The actual number of loaded
     * entries may be different; if there are many entries with the same date, we must
     * make sure to load all of them in a single batch, in order to avoid loading them
     * again later.
     *
     * @param aCount <integer> Requested number of entries.
     * @returns Promise<integer> that resolves to the actual number
     *          of entries that were loaded.
     */
    _loadEntries: function FeedView__loadEntries(aCount) {
        this._loading = true;

        let dateQuery = this.getQueryCopy();
        let edgeDate = undefined;

        if (this._loadedEntries.length) {
            let lastEntryDate = this.getEntryView(this.lastLoadedEntry).date.getTime();
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

        let dates = yield this._refreshGuard(dateQuery.getProperty('date', false));
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

            let loadedEntries = yield this._refreshGuard(query.getFullEntries());
            for (let entry of loadedEntries) {
                this._insertEntry(entry, this._loadedEntries.length);
                this._loadedEntries.push(entry.id);
            }

            this._loading = false;
            throw new Task.Result(loadedEntries.length);
        }
        else {
            this._loading = false;
            this._allEntriesLoaded = true;

            throw new Task.Result(0);
        }
    }.task(),

    _insertEntry: function FeedView__insertEntry(aEntryData, aPosition) {
        let entryView = new EntryView(this, aEntryData);

        let nextEntryView = this._entryViews[aPosition];
        let nextElem = nextEntryView ? nextEntryView.container : null;

        if (this.headlinesMode) {
            if (nextEntryView && entryView.day > nextEntryView.day)
                nextElem = nextElem.previousSibling;

            if (!this.document.getElementById('day' + entryView.day)) {
                let dayHeader = this.document.createElement('H1');
                dayHeader.id = 'day' + entryView.day;
                dayHeader.className = 'day-header';
                dayHeader.textContent = entryView.getDateString(true);

                this.feedContent.insertBefore(dayHeader, nextElem);
            }
        }

        this.feedContent.insertBefore(entryView.container, nextElem);

        this._entryViews.splice(aPosition, 0, entryView);
    },

    _setEmptyViewMessage: function FeedView__setEmptyViewMessage() {
        let messageBox = this.document.getElementById('message-box');
        if (this._loadedEntries.length) {
            messageBox.style.display = 'none';
            return;
        }

        let bundle = getElement('main-bundle');
        let mainMessage, secondaryMessage;

        if (this.query.searchString) {
            mainMessage = bundle.getString('noEntriesFound');
        }
        else if (this.query.read === false) {
            mainMessage = bundle.getString('noUnreadEntries');
        }
        else if (this.query.starred === true) {
            mainMessage = bundle.getString('noStarredEntries');
            secondaryMessage = bundle.getString('noStarredEntriesAdvice');
        }
        else if (this.query.deleted == Storage.ENTRY_STATE_TRASHED) {
            mainMessage = bundle.getString('trashIsEmpty');
        }
        else {
            mainMessage = bundle.getString('noEntries');
        }

        this.document.getElementById('main-message').textContent = mainMessage || '' ;
        this.document.getElementById('secondary-message').textContent = secondaryMessage || '';

        messageBox.style.display = '';
    },

    /**
     * Returns a new pomise that wraps the provided promise. The new promise will be
     * resolved with the value of the wrapped promise only if the view isn't refreshed
     * in the meantime. Otherwise, the new promise will be rejected.
     *
     * This function is used to make sure that if the view is refreshed while the
     * caller is waiting for an asynchronous function to complete, the caller will
     * stop execution.
     */
    _refreshGuard: function FeedView__refreshGuard(aWrappedPromise) {
        let oldViewID = this.viewID;

        return aWrappedPromise.then(
            value => {
                if (this.viewID == oldViewID && this == gCurrentView)
                    return value;
                else
                    throw new Error('Feed view refreshed while waiting for an async call to complete');
            }
        )
    },

    _callbackRefreshGuard: function FeedView__callbackRefreshGuard(aWrappedFunction) {
        let oldViewID = this.viewID;

        return () => {
            if (this.viewID == oldViewID && this == gCurrentView)
                aWrappedFunction.apply(undefined, arguments);
        };
    }

}



const DEFAULT_FAVICON_URL = 'chrome://brief/skin/icons/default-feed-favicon.png';
const RTL_LANGUAGE_CODES = ['ar', 'arc', 'dv', 'fa', 'ha', 'he', 'khw',
                            'ks', 'ku', 'ps', 'syr', 'ur', 'yi' ]


function EntryView(aFeedView, aEntryData) {
    this.feedView = aFeedView;

    this.id = aEntryData.id;
    this.date = new Date(aEntryData.date);
    this.entryURL = aEntryData.entryURL;
    this.feedID = aEntryData.feedID;

    this.headline = this.feedView.headlinesMode;

    this.container = this.feedView.document.getElementById('article-template').cloneNode(true);
    this.container.id = aEntryData.id;
    this.container.classList.add(this.headline ? 'headline' : 'full');

    this.read = aEntryData.read;
    this.starred = aEntryData.starred;
    this.tags = aEntryData.tags ? aEntryData.tags.split(', ') : [];

    let deleteButton = this._getElement('delete-button');
    let restoreButton = this._getElement('restore-button');
    if (this.feedView.query.deleted == Storage.ENTRY_STATE_TRASHED) {
        deleteButton.parentNode.removeChild(deleteButton);
        restoreButton.setAttribute('title', Strings.restoreEntryTooltip);
    }
    else {
        restoreButton.parentNode.removeChild(restoreButton);
        deleteButton.setAttribute('title', Strings.deleteEntryTooltip);
    }

    let feed = Storage.getFeed(aEntryData.feedID);

    // Set xml:base attribute to resolve relative URIs against the feed's URI.
    this.container.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'base', feed.feedURL);

    if (feed.language) {
        this.container.setAttribute('lang', feed.language);

        if (this.detectRTL.test(feed.language))
            this.textDirection = 'rtl';
    }

    let titleElem = this._getElement('title-link');
    if (aEntryData.entryURL)
        titleElem.setAttribute('href', aEntryData.entryURL);

    // Use innerHTML instead of textContent to resolve entities.
    titleElem.innerHTML = aEntryData.title || aEntryData.entryURL;

    this._getElement('feed-name').innerHTML = feed.title;
    this._getElement('authors').innerHTML = aEntryData.authors;

    this._getElement('date').textContent = this.getDateString();
    this._getElement('date').setAttribute('title', this.date.toLocaleString());

    if (aEntryData.markedUnreadOnUpdate) {
        this.container.classList.add('updated');
        this._getElement('updated-label').textContent = Strings.entryWasUpdated;

        let dateString = new Date(aEntryData.updated).toLocaleString();
        this._getElement('updated-label').setAttribute('title', dateString);
    }

    if (this.headline) {
        this.collapse(false);

        if (aEntryData.entryURL)
            this._getElement('headline-link').setAttribute('href', aEntryData.entryURL);

        let headlineTitle = this._getElement('headline-title');
        headlineTitle.innerHTML = aEntryData.title || aEntryData.entryURL;
        headlineTitle.setAttribute('title', aEntryData.title);
        headlineTitle.setAttribute('dir', this.textDirection);

        this._getElement('headline-feed-name').textContent = feed.title;

        let favicon = (feed.favicon && feed.favicon != 'no-favicon') ? feed.favicon
                                                                     : DEFAULT_FAVICON_URL;
        this._getElement('feed-icon').src = favicon;

        wait().then(() => {
            this._getElement('content').innerHTML = aEntryData.content;

            if (this.feedView.query.searchString)
                this._highlightSearchTerms(this._getElement('headline-title'));
        })
    }
    else {
        let contentElement = this._getElement('content');
        contentElement.innerHTML = aEntryData.content;
        contentElement.setAttribute('dir', this.textDirection);

        if (this.feedView.query.searchString) {
            wait().then(() => {
                for (let elem of ['authors', 'tags', 'title', 'content'])
                    this._highlightSearchTerms(this._getElement(elem));

                this._searchTermsHighlighted = true;
            })
        }
    }
}

EntryView.prototype = {

    textDirection: 'auto',

    detectRTL: new RegExp('^(' + RTL_LANGUAGE_CODES.join('|') + ')(-|$)'),

    get day() {
        let time = this.date.getTime() - this.date.getTimezoneOffset() * 60000;
        return Math.ceil(time / 86400000);
    },

    get read() {
        return this.__read;
    },
    set read(aValue) {
        this.__read = aValue;

        let button = this._getElement('mark-read-button');

        if (aValue) {
            this.container.classList.add('read');
            button.setAttribute('title', Strings.markEntryAsUnreadTooltip);

            this.container.classList.remove('updated');
        }
        else {
            this.container.classList.remove('read');
            button.setAttribute('title', Strings.markEntryAsReadTooltip);
        }
    },


    get starred() {
        return this.__starred;
    },
    set starred(aValue) {
        let button = this._getElement('bookmark-button')

        if (aValue) {
            this.container.classList.add('starred');
            button.setAttribute('title', Strings.editBookmarkTooltip);
        }
        else {
            this.container.classList.remove('starred');
            button.setAttribute('title', Strings.bookmarkEntryTooltip);
        }

        return this.__starred = aValue;
    },


    get tags() {
        return this.__tags;
    },
    set tags(aValue) {
        this._getElement('tags').textContent = aValue.sort().join(', ');
        return this.__tags = aValue;
    },


    __collapsed: false,

    get collapsed() {
        return this.__collapsed;
    },


    get selected() {
        return this.feedView.selectedEntry == this.id;
    },
    set selected(aValue) {
        if (aValue)
            this.container.classList.add('selected');
        else
            this.container.classList.remove('selected');

        return aValue;
    },


    get offsetTop() {
        return this.container.offsetTop;
    },

    get height() {
        return this.container.offsetHeight;
    },


    /**
     * Removes the entry view.
     *
     * @param aAnimate <boolean> [optional] Whether to animate or remove instantly.
     * @returns Promise<null> when finished.
     */
    remove: function EntryView_remove(aAnimate) {
        let deferred =  Promise.defer();

        if (aAnimate) {
            this.container.addEventListener('transitionend', () => {
                // The element may have been removed in the meantime
                // if the view had been refreshed.
                if (this.container.parentNode == this.feedView.feedContent) {
                    this.feedView.feedContent.removeChild(this.container);
                    deferred.resolve();
                }
            }, true);

            this.container.setAttribute('removing', true);
        }
        else {
            this.feedView.feedContent.removeChild(this.container);
            deferred.resolve();
        }

        return deferred.promise;
    },

    collapse: function EntryView_collapse(aAnimate) {
        if (this.collapsed)
            return;

        let headline = this._getElement('headline-container');
        headline.appendChild(this._getElement('controls'));

        hideElement(this._getElement('full-container'));
        showElement(this._getElement('headline-container'));

        this.container.classList.add('collapsed');

        this.__collapsed = true;
    },

    expand: function EntryView_expand(aAnimate) {
        if (!this.collapsed)
            return;

        let header = this._getElement('header');
        header.appendChild(this._getElement('controls'));

        this.container.classList.remove('collapsed');

        hideElement(this._getElement('headline-container'));

        showElement(this._getElement('full-container'), aAnimate).then(() => {
            if (this.container.parentNode != this.feedView.feedContent)
                return;

            if (PrefCache.autoMarkRead && this.feedView.query.read !== false)
                Commands.markEntryRead(this.id, true);

            if (this.selected) {
                let entryBottom = this.offsetTop + this.height;
                let screenBottom = this.feedView.window.pageYOffset +
                                   this.feedView.window.innerHeight;
                if (entryBottom > screenBottom)
                    this.feedView.scrollToEntry(this.id, false, true, true);
            }
        })


        if (this.feedView.query.searchString && !this._searchTermsHighlighted) {
            for (let elem of ['authors', 'tags', 'title', 'content'])
                this._highlightSearchTerms(this._getElement(elem));

            this._searchTermsHighlighted = true;
        }

        this.__collapsed = false;
    },

    onClick: function EntryView_onClick(aEvent) {
        // If the item is already being removed, no action should be taken
        if(this.container.getAttribute("removing"))
            return;

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

            if (anchor.getAttribute('command') == 'open') {
                Commands.openEntryLink(this.id);

                return;
            }
            else if (anchor.hasAttribute('href')) {
                let feedURL = Storage.getFeed(this.feedID).feedURL;
                let baseURI = NetUtil.newURI(feedURL);
                let linkURI = NetUtil.newURI(anchor.getAttribute('href'), null, baseURI);
                Commands.openLink(linkURI.spec);

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

                    let oldViewID = this.feedView.viewID;

                    query.getProperty('bookmarkID', false).then(
                        ids => {
                            if (this.feedView.viewID != oldViewID)
                                return;

                            let anchor = this._getElement('bookmark-button');
                            getTopWindow().StarUI.showEditBookmarkPopup(ids[0], anchor);
                        }
                    )
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

            case 'collapse':
                this.collapse(true);
                break;

            default:
                if (aEvent.button == 0 && this.collapsed)
                    this.expand(true);

        }
    },

    _getElement: function EntryView__getElement(aClassName) {
        return this.container.getElementsByClassName(aClassName)[0];
    },

    getDateString: function EntryView_getDateString(aOnlyDatePart) {
        let relativeDate = new RelativeDate(this.date.getTime());
        let currentDate = new Date();
        let string;
        let bundle = getElement('main-bundle');

        if (aOnlyDatePart) {
            switch (true) {
                case relativeDate.deltaDays === 0:
                    string = Strings['entryDate.today'];
                    break;

                case relativeDate.deltaDays === 1:
                    string = Strings['entryDate.yesterday'];
                    break;

                case relativeDate.deltaDays < 7:
                    string = this.date.toLocaleFormat('%A');
                    break;

                case currentDate.getFullYear() === this.date.getFullYear():
                    string = this.date.toLocaleFormat('%d %B');
                    break;

                default:
                    string = this.date.toLocaleFormat('%d %B %Y');
                    break;
            }
        }
        else {
            switch (true) {
                case relativeDate.deltaMinutes === 0:
                    string = Strings['entryDate.justNow'];
                    break;

                case relativeDate.deltaHours === 0:
                    let minuteForm = getPluralForm(relativeDate.deltaMinutes,
                                                   Strings['minute.pluralForms']);
                    string = bundle.getFormattedString('entryDate.ago', [minuteForm], 1)
                                   .replace('#number', relativeDate.deltaMinutes);
                    break;

                case relativeDate.deltaHours <= 12:
                    let hourForm = getPluralForm(relativeDate.deltaHours,
                                                 Strings['hour.pluralForms']);
                    string = bundle.getFormattedString('entryDate.ago', [hourForm], 1)
                                   .replace('#number', relativeDate.deltaHours);
                    break;

                case relativeDate.deltaDays === 0:
                    string = Strings['entryDate.today'] + this.date.toLocaleFormat(', %X');
                    break;

                case relativeDate.deltaDays === 1:
                    string = Strings['entryDate.yesterday'] + this.date.toLocaleFormat(', %X');
                    break;

                case relativeDate.deltaDays < 5:
                    string = this.date.toLocaleFormat('%A, %X')
                    break;

                case currentDate.getFullYear() === this.date.getFullYear():
                    string = this.date.toLocaleFormat('%d %b, %X')
                    break;

                default:
                    string = this.date.toLocaleFormat('%d %b %Y, %X')
                    break;
            }
        }

        return string.replace(/:\d\d$/, ' ').replace(/^0/, '');
    },

    _highlightSearchTerms: function EntryView__highlightSearchTerms(aElement) {
        for (let term of this.feedView.query.searchString.match(/[^\s:\*"-]+/g)) {
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
    }

}


function hideElement(aElement, aAnimate) {
    let deferred = Promise.defer();

    if (aAnimate) {
        aElement.style.opacity = '0';
        aElement.setAttribute('hiding', true);

        aElement.addEventListener('transitionend', event => {
            aElement.removeEventListener('transitionend', arguments.callee, false);
            aElement.removeAttribute('hiding');

            aElement.style.display = 'none';
            aElement.style.opacity = '';

            deferred.resolve();
        }, false);
    }
    else {
        aElement.style.display = 'none';
        aElement.style.opacity = '0';

        deferred.resolve();
    }

    return deferred.promise;
}

function showElement(aElement, aAnimate) {
    let deferred = Promise.defer();

    if (aAnimate) {
        aElement.style.display = '';
        aElement.style.opacity = '0';
        aElement.offsetHeight; // Force reflow.

        aElement.style.opacity = '';
        aElement.setAttribute('showing', true);

        aElement.addEventListener('transitionend', event => {
            aElement.removeEventListener('transitionend', arguments.callee, false);
            aElement.removeAttribute('showing');

            deferred.resolve();
        }, false);
    }
    else {
        aElement.style.display = '';
        aElement.style.opacity = '';

        deferred.resolve();
    }

    return deferred.promise;
}


__defineGetter__('Strings', () => {
    let cachedStringsList = [
        'entryDate.justNow',
        'minute.pluralForms',
        'hour.pluralForms',
        'entryDate.today',
        'entryDate.yesterday',
        'entryWasUpdated',
        'markEntryAsUnreadTooltip',
        'markEntryAsReadTooltip',
        'deleteEntryTooltip',
        'restoreEntryTooltip',
        'bookmarkEntryTooltip',
        'editBookmarkTooltip',
    ]

    let bundle = getElement('main-bundle');
    let obj = {};
    for (let stringName of cachedStringsList)
        obj[stringName] = bundle.getString(stringName);

    delete this.Strings;
    return this.Strings = obj;
})

__defineGetter__('Finder', () => {
    let finder = Cc['@mozilla.org/embedcomp/rangefind;1'].createInstance(Ci.nsIFind);
    finder.caseSensitive = false;

    delete this.Finder;
    return this.Finder = finder;
})

__defineGetter__('gBriefPrincipal', () => {
    let uri = NetUtil.newURI(document.documentURI);
    let resolvedURI = Cc['@mozilla.org/chrome/chrome-registry;1']
                      .getService(Ci.nsIChromeRegistry)
                      .convertChromeURL(uri);

    // Firefox 16 compatibility.
    let ssm = Services.scriptSecurityManager;
    let principal = ssm.getCodebasePrincipal ? ssm.getCodebasePrincipal(resolvedURI)
                                             : ssm.getSimpleCodebasePrincipal(resolvedURI);

    delete this.gBriefPrincipal;
    return this.gBriefPrincipal = principal;
})
