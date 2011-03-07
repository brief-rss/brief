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
const HEADLINES_LOAD_STEP_SIZE = 20;


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

    this.browser.addEventListener('load', this, false);
    getTopWindow().gBrowser.tabContainer.addEventListener('TabSelect', this, true);
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
        let query = this.query;
        let copy = new Query();
        for (let property in query)
            copy[property] = query[property];
        return copy;
    },

    containsEntry: function FeedView_containsEntry(aEntry) {
        return this._loadedEntries.indexOf(aEntry) != -1;
    },

    getEntryIndex: function FeedView_getEntryIndex(aEntry) {
        return this._loadedEntries.indexOf(aEntry);
    },

    collapseEntry: function FeedView_collapseEntry(aEntry, aAnimate) {
        let entryContainer = this.document.getElementById(aEntry);
        if (entryContainer.hasAttribute('collapsed'))
            return;

        let entryContent = entryContainer.getElementsByClassName('article-content')[0];

        let finish = function() {
            entryContent.removeEventListener('transitionend', finish, true);
            if (entryContainer.parentNode != this.feedContent)
                return;

            entryContainer.removeAttribute('collapsing');
            entryContainer.setAttribute('collapsed', true);

            let date = entryContainer.getElementsByClassName('article-date')[0];
            let feedName = entryContainer.getElementsByClassName('feed-name')[0];
            let collapsedSubheader = entryContainer.getElementsByClassName('collapsed-article-subheader')[0];

            collapsedSubheader.insertBefore(date, null);
            collapsedSubheader.insertBefore(feedName, null);
        }.bind(this)

        entryContent.style.height = '0';
        entryContent.style.opacity = '0';

        if (aAnimate) {
            entryContent.addEventListener('transitionend', finish, true);
            entryContainer.setAttribute('collapsing', true);
        }
        else {
            finish();
        }
    },

    uncollapseEntry: function FeedView_uncollapseEntry(aEntry, aAnimate) {
        let entryContainer = this.document.getElementById(aEntry);
        if (!entryContainer.hasAttribute('collapsed'))
            return;

        let entryContent = entryContainer.getElementsByClassName('article-content')[0];

        let finish = function() {
            entryContent.removeEventListener('transitionend', finish, true);
            if (entryContainer.parentNode != this.feedContent)
                return;

            entryContainer.removeAttribute('collapsing');

            if (PrefCache.autoMarkRead && this.query.read !== false)
                Commands.markEntryRead(aEntry, true);

            if (aEntry == this.selectedEntry) {
                let entryBottom = this.selectedElement.offsetTop + this.selectedElement.offsetHeight;
                let windowBottom = this.window.pageYOffset + this.window.innerHeight;
                if (entryBottom > windowBottom)
                    this.scrollToEntry(aEntry, false, true);
            }
        }.bind(this)

        let subheaderLeft = entryContainer.getElementsByClassName('article-subheader-left')[0];
        let subheaderRight = entryContainer.getElementsByClassName('article-subheader-right')[0];
        let date = entryContainer.getElementsByClassName('article-date')[0];
        let feedName = entryContainer.getElementsByClassName('feed-name')[0];
        let tagsElem = entryContainer.getElementsByClassName('article-tags')[0];

        subheaderLeft.insertBefore(feedName, tagsElem);
        subheaderRight.insertBefore(date, null);

        entryContainer.removeAttribute('collapsed');

        // CSS transitions don't work with "height: auto". To work around it, we retrieve
        // the computed style of "height: auto" content and we set the height explicitly.
        // This de-facto height has to be retrieved before the entry is uncollapsed
        // - it cannot be saved upfront, when the entry is inserted, because it may
        // change as images and such are loaded.
        entryContent.style.height = '';
        entryContent.offsetHeight; // Force reflow.
        let naturalHeight = this.window.getComputedStyle(entryContent)
                                       .getPropertyValue('height');

        // Restore the old height.
        entryContent.style.height = '0';
        entryContent.offsetHeight; // Force reflow.

        // Uncollapse.
        entryContent.style.height = naturalHeight;
        entryContent.style.opacity = '1';

        if (aAnimate) {
            entryContainer.setAttribute('collapsing', true);
            entryContent.addEventListener('transitionend', finish, true);
        }
        else {
            finish();
        }

        if (this.query.searchString) {
            this._highlightSearchTerms(aEntry);
            entryElement.setAttribute('searchTermsHighlighted', true);
        }
    },

    get selectedElement() {
        return this.selectedEntry ? this.document.getElementById(this.selectedEntry)
                                  : null;
    },

    selectNextEntry: function FeedView_selectNextEntry() {
        if (this._scrolling)
            return;

        if (PrefCache.entrySelectionEnabled) {
            let entryElement = this.selectedElement.nextSibling;
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
            let entryElement = this.selectedElement.previousSibling;
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

        let entry = (typeof aEntry == 'number' || !aEntry) ? aEntry
                                                           : parseInt(aEntry.id);

        if (this.selectedElement)
            this.selectedElement.removeAttribute('selected');

        this.selectedEntry = entry;

        if (entry) {
            this.selectedElement.setAttribute('selected', true);

            if (aScroll)
                this.scrollToEntry(entry, true, aScrollSmoothly);
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
        let middleElement = this._getMiddleEntryElement();
        if (middleElement)
            var previousElement = middleElement.previousSibling;

        if (previousElement)
            this.scrollToEntry(parseInt(previousElement.id), true, aSmooth);
    },


    // See scrollToPrevEntry.
    scrollToNextEntry: function FeedView_scrollToNextEntry(aSmooth) {
        let middleElement = this._getMiddleEntryElement();
        if (middleElement)
            var nextElement = middleElement.nextSibling;

        if (nextElement)
            this.scrollToEntry(parseInt(nextElement.id), true, aSmooth);
    },

    /**
     * Scroll down by 10 entries, loading more entries if necessary.
     */
    skipDown: function FeedView_skipDown() {
        let middleEntry = parseInt(this._getMiddleEntryElement().id);
        let index = this.getEntryIndex(middleEntry);

        let doSkipDown = function(aCount) {
            let targetEntry = this._loadedEntries[index + 10] ||
                              this._loadedEntries[this._loadedEntries.length - 1];

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
        let middleEntry = parseInt(this._getMiddleEntryElement().id);
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
        let entryElement = this.document.getElementById(aEntry);

        if (entryElement.offsetHeight >= win.innerHeight) {
            var targetPosition = entryElement.offsetTop;
        }
        else if (aCentre) {
            let difference = win.innerHeight - entryElement.offsetHeight;
            targetPosition = entryElement.offsetTop - Math.floor(difference / 2);
        }
        else {
            targetPosition = (entryElement.offsetTop + entryElement.offsetHeight) - win.innerHeight;
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

        let win = this.window;

        let distance = aTargetPosition - win.pageYOffset;
        with (Math) {
            let jumpCount = exp(abs(distance) / 400) + 6;
            jumpCount = max(jumpCount, 7);
            jumpCount = min(jumpCount, 15);

            var jump = round(distance / jumpCount);
        }

        this._scrolling = setInterval(function() {
            // If we are within epsilon smaller or equal to the jump,
            // then scroll directly to the target position.
            if (Math.abs(aTargetPosition - win.pageYOffset) <= Math.abs(jump)) {
                win.scroll(win.pageXOffset, aTargetPosition)
                this._stopSmoothScrolling();

                // One more scroll event will be sent but _scrolling is already null,
                // so the event handler will try to automatically select the central
                // entry. This has to be prevented, because it may deselect the entry
                // that the user has just selected manually.
                this._ignoreNextScrollEvent = true;
            }
            else {
                win.scroll(win.pageXOffset, win.pageYOffset + jump);
            }
        }.bind(this), 10)
    },

    _stopSmoothScrolling: function FeedView__stopSmoothScrolling() {
        clearInterval(this._scrolling);
        this._scrolling = null;
    },

    // Return the entry element closest to the middle of the screen.
    _getMiddleEntryElement: function FeedView__getMiddleEntryElement() {
        let elems = this.feedContent.childNodes;
        if (!elems.length)
            return null;

        let middleLine = this.window.pageYOffset + Math.round(this.window.innerHeight / 2);

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
        let winTop = this.window.pageYOffset;
        let winBottom = winTop + this.window.innerHeight;
        let entries = this.feedContent.childNodes;

        let entriesToMark = [];

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
        for (let entry in this._loadedEntries) {
            if (PrefCache.showHeadlinesOnly)
                this.collapseEntry(entry, false);
            else
                this.uncollapseEntry(entry, false);
        }

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
        getTopWindow().gBrowser.tabContainer.removeEventListener('TabSelect', this, false);
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
    _events: ['click', 'scroll', 'keypress'],

    handleEvent: function FeedView_handleEvent(aEvent) {
        let target = aEvent.target;
        let id = parseInt(target.id);

        // Checking if default action has been prevented helps Brief play nicely with
        // other extensions. In Gecko <1.9.2 getPreventDefault() is available only
        // for UI events.
        if (aEvent instanceof Ci.nsIDOMNSUIEvent && aEvent.getPreventDefault())
            return;

        switch (aEvent.type) {
            // Set up the template page when it's loaded.
            case 'load':
                getElement('feed-view-header').hidden = !this.active;

                if (this.active) {
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
                if (this._refreshPending && aEvent.originalTarget == getTopWindow().Brief.getBriefTab()) {
                    this.refresh();
                    this._refreshPending = false;
                }
                break;
        }
    },

    _onClick: function FeedView__onClick(aEvent) {
        // This loop walks the parent chain of the even target to check if the
        // article-container and/or an anchor were clicked.
        let elem = aEvent.target;
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

            let openInTabs = Prefs.getBoolPref('feedview.openEntriesInTabs');
            let newTab = openInTabs || aEvent.button == 1 || aEvent.ctrlKey;

            if (anchor.className == 'article-title-link')
                Commands.openEntryLink(entryElement, newTab);
            else if (anchor.hasAttribute('href'))
                Commands.openLink(anchor.getAttribute('href'), newTab);
        }

        if (!entryElement)
            return;

        if (PrefCache.entrySelectionEnabled)
            this.selectEntry(parseInt(entryElement.id));

        let entryID = parseInt(entryElement.id);
        let command = aEvent.target.getAttribute('command');

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

                        query.getProperty('bookmarkID', false, function(ids) {
                            let starElem = entryElement.getElementsByClassName('article-star')[0];
                            getTopWindow().StarUI.showEditBookmarkPopup(ids[0], starElem,
                                                                        'after_start');
                        })
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
            this.uncollapseEntry(entryID, true);
        }
        else {
            let className = aEvent.target.className;
            if ((className == 'article-header' || className == 'article-title-link-box')
                    && PrefCache.showHeadlinesOnly) {
                this.collapseEntry(entryID, true);
            }
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
            let entryElement = this.document.getElementById(entry);
            let markReadButton = entryElement.getElementsByClassName('mark-read')[0];

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

        for (let entry in this._loadedEntries.intersect(aEntryList.IDs)) {
            let entryElement = this.document.getElementById(entry);
            if (aNewState)
                entryElement.setAttribute('starred', 'true');
            else
                entryElement.removeAttribute('starred');
        }
    },

    onEntriesTagged: function FeedView_onEntriesTagged(aEntryList, aNewState, aTag) {
        if (!this.active)
            return;

        for (let entry in this._loadedEntries.intersect(aEntryList.IDs)) {
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
            let tagsElement = entryElement.getElementsByClassName('article-tags')[0];
            tagsElement.textContent = tags;
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
        query.startDate = parseInt(this.feedContent.lastChild.getAttribute('date'));

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

            let entryContainer = this.document.getElementById(entryID);

            entryContainer.addEventListener('transitionend', function() {
                // The element may have been removed in the meantime
                // if the view had been refreshed.
                if (entryContainer.parentNode != this.feedContent)
                    return;

                this.feedContent.removeChild(entryContainer);
                this._loadedEntries.splice(indices[0], 1);
                this._afterEntriesRemoved(aLoadNewEntries, selectedEntryIndex);
            }.bind(this), true);

            entryContainer.setAttribute('removing', true);
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
                let newSelection = this._loadedEntries[aPrevSelectedIndex] ||
                                   this._loadedEntries[this._loadedEntries.length - 1];
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
        let container = this.document.getElementById('container');
        container.removeChild(this.feedContent);
        let content = this.document.createElement('div');
        content.id = 'feed-content';
        container.appendChild(content);

        // Prevent the message from briefly showing up before entries are loaded.
        this.document.getElementById('message-box').style.display = 'none';

        this._buildHeader();

        // Pass parameters to content.
        if (this.query.deleted == Storage.ENTRY_STATE_TRASHED)
            this.feedContent.setAttribute('trash', true);
        if (PrefCache.showHeadlinesOnly)
            this.feedContent.setAttribute('showHeadlinesOnly', true);

        // Temporarily remove the listener because reading window.innerHeight
        // can trigger a resize event (!?).
        this.window.removeEventListener('resize', this, false);

        this._fillWindow(INITIAL_WINDOW_HEIGHTS_LOAD, function() {
            // Resize events can be dispatched asynchronously, so this listener shouldn't
            // be earlier along with others, because then it could be triggered before
            // the initial refresh.
            this.window.addEventListener('resize', this, false);

            this._setEmptyViewMessage();
            this._autoMarkRead();

            if (PrefCache.entrySelectionEnabled) {
                let lastSelectedEntry = this.selectedEntry;
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
        if (this._loadingEntries || this.enoughEntriesPreloaded && !this.lastEntryInCenter) {
            if (aCallback)
                aCallback();
            return;
        }

        let stepSize = PrefCache.showHeadlinesOnly ? HEADLINES_LOAD_STEP_SIZE
                                                   : LOAD_STEP_SIZE;

        do var loadedCount = yield this._loadEntries(stepSize, arguments.callee.resume);
        while (loadedCount && (!this.enoughEntriesPreloaded || this.lastEntryInCenter))

        if (aCallback)
            aCallback();
    }.gen(),

    get lastEntryInCenter() {
        return this._getMiddleEntryElement() == this.feedContent.lastChild;
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
        this._loadingEntries = true;

        let dateQuery = this.getQueryCopy();
        let edgeDate = undefined;

        let lastEntryElement = this.feedContent.lastChild;
        if (lastEntryElement) {
            let lastEntryDate = parseInt(lastEntryElement.getAttribute('date'));
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

        let dates = yield dateQuery.getProperty('date', false, arguments.callee.resume);
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

            var entries = yield query.getFullEntries(arguments.callee.resume);
            entries.forEach(this._appendEntry, this);
        }

        this._loadingEntries = false;

        aCallback(entries ? entries.length : 0);
    }.gen(),

    _appendEntry: function FeedView__appendEntry(aEntry) {
        this._insertEntry(aEntry, this._loadedEntries.length);
        this._loadedEntries.push(aEntry.id);
    },

    _insertEntry: function FeedView__appendEntry(aEntry, aPosition) {
        let entryContainer = this.document.getElementById('article-template')
                                          .cloneNode(true);

        let nextEntry = this.feedContent.childNodes[aPosition];
        this.feedContent.insertBefore(entryContainer, nextEntry);

        entryContainer.setAttribute('id', aEntry.id);

        if (aEntry.read)
            entryContainer.setAttribute('read', true);

        let titleElem = entryContainer.getElementsByClassName('article-title-link')[0];
        if (aEntry.entryURL) {
            entryContainer.setAttribute('entryURL', aEntry.entryURL);
            titleElem.setAttribute('href', aEntry.entryURL);
        }

        // Use innerHTML instead of textContent, so that the entities are resolved.
        titleElem.innerHTML = aEntry.title || aEntry.entryURL;

        let tagsElem = entryContainer.getElementsByClassName('article-tags')[0];
        tagsElem.textContent = aEntry.tags;

        let markReadElem = entryContainer.getElementsByClassName('mark-read')[0];
        markReadElem.textContent = aEntry.read ? this._strings.markAsUnread
                                               : this._strings.markAsRead;

        // When view contains entries from many feeds, show feed name on each entry.
        if (!Storage.getFeed(this.query.feeds)) {
            let feedNameElem = entryContainer.getElementsByClassName('feed-name')[0];
            feedNameElem.innerHTML = Storage.getFeed(aEntry.feedID).title;
        }

        let authorsElem = entryContainer.getElementsByClassName('article-authors')[0];
        if (aEntry.authors) {
            authorsElem.innerHTML = aEntry.authors;
        }

        if (aEntry.starred)
            entryContainer.setAttribute('starred', true);

        entryContainer.setAttribute('date', aEntry.date);

        let dateString = this._constructEntryDate(aEntry);
        if (aEntry.updated) {
            var updatedString = dateString + ' <span class="article-updated">'
                                + this._strings.entryUpdated + '</span>'
            entryContainer.setAttribute('updated', true);
        }

        let dateElem = entryContainer.getElementsByClassName('article-date')[0];
        dateElem.innerHTML = updatedString || dateString;

        let contentElem = entryContainer.getElementsByClassName('article-content')[0];
        if (PrefCache.showHeadlinesOnly) {
            this.collapseEntry(aEntry.id, false);

            // In headlines view, insert the entry content asynchornously for better
            // perceived performance.
            async(function() {
                contentElem.innerHTML = aEntry.content;

                // Highlight search terms in the entry title.
                if (this.query.searchString)
                    async(function() this._highlightSearchTerms(aEntry.id), 0, this);
            }, 0, this)
        }
        else {
            contentElem.innerHTML = aEntry.content;

            if (this.query.searchString) {
                async(function() {
                    this._highlightSearchTerms(aEntry.id);
                    entryContainer.setAttribute('searchTermsHighlighted', true);
                } , 0, this);
            }
        }

        return entryContainer;
    },


    _constructEntryDate: function FeedView__constructEntryDate(aEntry) {
        let entryDate = new Date(aEntry.date);
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

        return string;
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


    _highlightSearchTerms: function FeedView__highlightSearchTerms(aEntry) {
        let entryElement = this.document.getElementById(aEntry);

        if (entryElement.hasAttribute('searchTermsHighlighted'))
            return;

        let finder = Cc['@mozilla.org/embedcomp/rangefind;1'].createInstance(Ci.nsIFind);
        finder.caseSensitive = false;

        for (let term in this.query.searchString.match(/[A-Za-z0-9]+/g)) {
            let searchRange = this.document.createRange();
            searchRange.setStart(entryElement, 0);
            searchRange.setEnd(entryElement, entryElement.childNodes.length);

            let startPoint = this.document.createRange();
            startPoint.setStart(entryElement, 0);
            startPoint.setEnd(entryElement, 0);

            let endPoint = this.document.createRange();
            endPoint.setStart(entryElement, entryElement.childNodes.length);
            endPoint.setEnd(entryElement, entryElement.childNodes.length);

            let baseNode = this.document.createElement('span');
            baseNode.className = 'search-highlight';

            let retRange;
            while (retRange = finder.Find(term, searchRange, startPoint, endPoint)) {
                let surroundingNode = baseNode.cloneNode(false);
                surroundingNode.appendChild(retRange.extractContents());

                let before = retRange.startContainer.splitText(retRange.startOffset);
                before.parentNode.insertBefore(surroundingNode, before);

                startPoint.setStart(surroundingNode, surroundingNode.childNodes.length);
                startPoint.setEnd(surroundingNode, surroundingNode.childNodes.length);
            }
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
    let uri = NetUtil.newURI(document.documentURI);
    let resolvedURI = Cc['@mozilla.org/chrome/chrome-registry;1']
                      .getService(Ci.nsIChromeRegistry)
                      .convertChromeURL(uri);

    delete this.gBriefPrincipal;
    return this.gBriefPrincipal = gSecurityManager.getCodebasePrincipal(resolvedURI);
});