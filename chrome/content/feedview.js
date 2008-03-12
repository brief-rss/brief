/**
 * gFeedView is the instance of FeedView currently attached to the browser.
 */
var gFeedView = null;

function setView(aView) {
    // Detach the previous view.
    if (gFeedView) {
        gFeedView.browser.removeEventListener('load', gFeedView, false);
        clearInterval(gFeedView._smoothScrollInterval);
        gFeedView._smoothScrollInterval = null;
        clearTimeout(gFeedView._markVisibleTimeout);
    }

    // Attach the new view and set up the necessary UI pieces.
    gFeedView = aView;
    aView.browser.addEventListener('load', aView, false);

    // Clear the searchbar.
    if (!aView.query.searchString) {
        var searchbar = document.getElementById('searchbar');
        searchbar.setAttribute('showingDescription', true);
    }

    // If view is tied to specified intrinsic flags (e.g. the "Unread" view),
    // hide the UI to pick the flags.
    var viewConstraintBox = document.getElementById('view-constraint-box');
    viewConstraintBox.hidden = aView._flagsAreIntrinsic;

    aView._refresh();
}

/**
 * This object represents the main feed display. It stores and manages
 * the display parameters.
 *
 * @param aTitle  Title of the view which will be shown in the header.
 * @param aQuery  Query selecting entries to be displayed.
 */
function FeedView(aTitle, aQuery) {
    this.title = aTitle;

    this._flagsAreIntrinsic = aQuery.read || aQuery.unread || aQuery.starred ||
                              aQuery.unstarred || aQuery.deleted != ENTRY_STATE_NORMAL;
    this.query = aQuery;
    this.query.sortOrder = Ci.nsIBriefQuery.SORT_BY_DATE;

    this.entriesMarkedUnread = [];
}


FeedView.prototype = {

    // Title of the view which is displayed in the header.
    title: '',

    // This property is used to temporarily override the title without losing the old one.
    // It used for searching, when the search string is displayed in place of the title.
    titleOverride: '',

    // Indicates if the view was created with intrinsic flags which override the
    // feedview.shownEntries preference.
    _flagsAreIntrinsic: false,

    // IDs of contained entries, used for determining if the view needs refreshing.
    _entries: [],

    // Key elements.
    get browser FeedView_get_browser() {
        delete this.__proto__.browser;
        return this.__proto__.browser = document.getElementById('feed-view');
    },

    get document FeedView_get_document() this.browser.contentDocument,

    feedContent: null,


    // Query that selects entries contained by the view. It is the query to pull ALL the
    // entries, not only the ones displayed on the current page.
    __query: null,
    set query FeedView_set_query(aQuery) {
        this.__query = aQuery;
        return aQuery;
    },
    get query FeedView_get_query() {
        if (!this._flagsAreIntrinsic) {
            this.__query.unread = (gPrefs.shownEntries == 'unread');
            this.__query.starred = (gPrefs.shownEntries == 'starred');
            this.__query.deleted = gPrefs.shownEntries == 'trashed' ? ENTRY_STATE_TRASHED
                                                                    : ENTRY_STATE_NORMAL;
        }
        this.__query.limit = 0;
        this.__query.offset = 1;

        return this.__query;
    },


    pageCount:     0,
    entriesCount:  0,

    __currentPage: 1,
    set currentPage FeedView_set_currentPage(aPageNumber) {
        if (aPageNumber != this.__currentPage && aPageNumber <= this.pageCount && aPageNumber > 0) {
            this.__currentPage = aPageNumber;
            this.ensure(true);
        }
    },
    get currentPage FeedView_get_currentPage() this.__currentPage,


    // Indicates whether the feed view is currently displayed in the browser.
    get isActive FeedView_get_isActive() this.browser.currentURI.equals(gTemplateURI),

    get isGlobalSearch FeedView_get_isGlobalSearch() {
        return !this.query.folders && !this.query.feeds && !this._flagsAreIntrinsic
               && this.query.searchString;
    },

    get isViewSearch FeedView_get_isGlobalSearch() {
        return (this.query.folders || this.query.feeds || this._flagsAreIntrinsic)
               && gFeedView.query.searchString;
    },


    collapseEntry: function FeedView_collapseEntry(aEntry, aNewState, aAnimate) {
        var eventType = aAnimate ? 'DoCollapseEntryAnimated' : 'DoCollapseEntry';
        this._sendEvent(aEntry, eventType, aNewState);
    },


    /**
     * Sends an event to an entry displayed on the current page, can a message to
     * perform an action or update its state. This is the only way we can communicate
     * with the untrusted document.
     *
     * @param aTargetEntry  ID of the target entry.
     * @param aEventType    Type of the event.
     * @param aState        Additional parameter, the new state of the entry.
     */
    _sendEvent: function FeedView__sendEvent(aTargetEntry, aEventType, aState) {
        var evt = document.createEvent('Events');
        evt.initEvent('ViewEvent', false, false);

        var element = this.document.getElementById(aTargetEntry);
        element.setAttribute('eventType', aEventType);
        element.setAttribute('eventState', aState);

        element.dispatchEvent(evt);
    },


    // ID of the selected entry.
    selectedEntry: '',

    get selectedElement() {
        return this.selectedEntry ? this.document.getElementById(this.selectedEntry)
                                  : null;
    },

    // Used when going back one page by selecting previous
    // entry when the topmost entry is selected.
    _selectLastEntryOnRefresh: false,

    // Temporarily disable selecting entries.
    _selectionSuppressed: false,

    selectNextEntry: function FeedView_selectNextEntry() {
        if (this._selectionSuppressed)
            return;

        if (gPrefs.keyNavEnabled) {
            var entry = this.selectedElement.nextSibling.id;

            if (entry)
                this.selectEntry(entry, true, true);
            else
                this.currentPage++;
        }
        else {
            this.switchKeyboardSelection();
        }
    },

    selectPrevEntry: function FeedView_selectPrevEntry() {
        if (this._selectionSuppressed)
            return;

        if (gPrefs.keyNavEnabled) {
            var entry = this.selectedElement.previousSibling.id;

            if (entry) {
                this.selectEntry(entry, true, true);
            }
            // Normally we wouldn't have to check |currentPage > 1|, because
            // the setter validates the input. However, we don't want to set
            // _selectLastEntryOnRefresh and then not refresh.
            else if (this.currentPage > 1) {
                this._selectLastEntryOnRefresh = true;
                this.currentPage--;
            }
        }
        else {
            this.switchKeyboardSelection();
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
        if (this.isActive) {
            var entry = (typeof aEntry == 'string' || !aEntry) ? aEntry : aEntry.id;

            if (this.selectedElement)
                this.selectedElement.removeAttribute('selected');

            this.selectedEntry = entry;

            if (entry) {
                this.selectedElement.setAttribute('selected', true);

                if (aScroll)
                    this.scrollToEntry(entry, aScrollSmoothly);
            }
        }
    },

    /**
     * Scrolls to the next entry after the entry closest to the middle of the screen.
     *
     * @param aSmooth Set to TRUE to scroll smoothly, FALSE to jump directly to the
     *                target position.
     */
    scrollToPrevEntry: function FeedView_scrollToPrevEntry(aSmooth) {
        var middleElement = this._getMiddleEntryElement();
        if (middleElement)
            var previousElement = middleElement.previousSibling;

        if (previousElement)
            this.scrollToEntry(previousElement.id, aSmooth);
    },


    // See scrollToPrevEntry.
    scrollToNextEntry: function FeedView_scrollToNextEntry(aSmooth) {
        var win = this.document.defaultView;
        var middleElement = this._getMiddleEntryElement();
        if (middleElement)
            var nextElement = middleElement.nextSibling;

        if (nextElement)
            this.scrollToEntry(nextElement.id, aSmooth);
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
        var win = this.document.defaultView;
        var entryElement = this.document.getElementById(aEntry);

        if (entryElement.offsetHeight >= win.innerHeight) {
            var targetPosition = entryElement.offsetTop;
        }
        else {
            var difference = win.innerHeight - entryElement.offsetHeight;
            targetPosition = entryElement.offsetTop - Math.floor(difference / 2);
        }

        if (targetPosition < 0)
            targetPosition = 0;
        else if (targetPosition > win.scrollMaxY)
            targetPosition = win.scrollMaxY;

        if (targetPosition != win.pageYOffset) {
            if (aSmooth)
                this._scrollSmoothly(targetPosition);
            else
                win.scroll(win.pageXOffset, targetPosition);
        }
    },


    _smoothScrollInterval: null,

    _scrollSmoothly: function FeedView__scrollSmoothly(aTargetPosition) {

        // Don't start if scrolling is already in progress.
        if (this._smoothScrollInterval)
            return;

        var win = this.document.defaultView;

        var delta = aTargetPosition - win.pageYOffset;
        var jump = Math.round(delta / 10);
        if (jump === 0)
            jump = (delta > 0) ? 1 : -1;

        var self = this;

        function scroll() {
            // If we are within epsilon smaller or equal to the jump,
            // then scroll directly to the target position.
            if (Math.abs(aTargetPosition - win.pageYOffset) <= Math.abs(jump)) {
                win.scroll(win.pageXOffset, aTargetPosition)
                clearInterval(self._smoothScrollInterval);
                self._smoothScrollInterval = null;
                self._selectionSuppressed = false;
            }
            else {
                win.scroll(win.pageXOffset, win.pageYOffset + jump);
            }
        }

        // Disallow selecting futher entries until scrolling is finished.
        this._selectionSuppressed = true;

        this._smoothScrollInterval = setInterval(scroll, 7);
    },


    // Return the element of the entry closest to the middle of the screen.
    _getMiddleEntryElement: function FeedView__getMiddleEntryElement() {
        var elems = this.feedContent.childNodes;
        if (!elems.length)
            return null;

        var win = this.document.defaultView;
        var middleLine = win.pageYOffset + Math.round(win.innerHeight / 2);

        // Get the element in the middle of the screen.
        for (var i = 0; i < elems.length - 1; i++) {
            if (elems[i].offsetTop <= middleLine && elems[i + 1].offsetTop > middleLine) {
                var middleElement = elems[i];
                break;
            }
        }

        return middleElement || elems[elems.length - 1];
    },


    switchKeyboardSelection: function FeedView_switchKeyboardSelection() {
        gPrefs.setBoolPref('feedview.keyNavEnabled', !gPrefs.keyNavEnabled);

        if (gPrefs.keyNavEnabled)
            this.selectEntry(this._getMiddleEntryElement());
        else
            this.selectEntry(null);
    },


    // This array stores the list of entries marked as unread by the user.
    // They become excluded from auto-marking, in order to prevent them from
    // being immediately re-marked as read when autoMarkRead is on.
    entriesMarkedUnread: [],

    _markVisibleTimeout: null,

    markVisibleAsRead: function FeedView_markVisibleAsRead() {
        if (gPrefs.autoMarkRead && !gPrefs.showHeadlinesOnly && !this.query.unread) {
            clearTimeout(this._markVisibleTimeout);
            this._markVisibleTimeout = async(this._doMarkVisibleAsRead, 1000, this);
        }
    },

    _doMarkVisibleAsRead: function FeedView__doMarkVisibleAsRead() {
        var win = this.document.defaultView;
        var winTop = win.pageYOffset;
        var winBottom = winTop + win.innerHeight;
        var entriesToMark = [], entryTop, wasMarkedUnread, i;

        var entries = this.feedContent.childNodes;

        for (i = 0; i < entries.length; i++) {
            entryTop = entries[i].offsetTop;
            wasMarkedUnread = (this.entriesMarkedUnread.indexOf(entries[i].id) != -1);

            if (entryTop >= winTop && entryTop < winBottom - 50 && !wasMarkedUnread)
                entriesToMark.push(entries[i].id);
        }

        if (entriesToMark.length) {
            var query = new QuerySH(null, entriesToMark.join(' '), false);
            query.markEntriesRead(true);
        }
    },


    handleEvent: function FeedView_handleEvent(aEvent) {
        var target = aEvent.target;

        switch (aEvent.type) {

            // Forward commands from the view to the controller.
            case 'SwitchEntryRead':
                var newState = target.hasAttribute('read');
                gCommands.markEntryRead(target.id, newState);
                break;
            case 'DeleteEntry':
                gCommands.deleteEntry(target.id);
                break;
            case 'RestoreEntry':
                gCommands.restoreEntry(target.id);
                break;
            case 'SwitchEntryStarred':
                var newState = target.hasAttribute('starred');
                gCommands.starEntry(target.id, newState);
                break;

            case 'EntryUncollapsed':
                if (gPrefs.autoMarkRead && !this.query.unread)
                    gCommands.markEntryRead(target.id, true);
                break;

            case 'load':
                var feedViewToolbar = document.getElementById('feed-view-toolbar');

                if (this.isActive) {
                    feedViewToolbar.hidden = false;
                    this._buildFeedView();
                }
                else {
                    feedViewToolbar.hidden = true;
                    gTopBrowserWindow.gBrief.contextMenuTarget = null;
                }
                break;

            case 'scroll':
                this.markVisibleAsRead();
                break;

            case 'click':
                this._onClick(aEvent);
                break;

            // We store targets of right-clicks to override document.popupNode, so that
            // context menu sees anonymous content.
            case 'mousedown':
                if (aEvent.button == 2 && this.isActive)
                    gTopBrowserWindow.gBrief.contextMenuTarget = aEvent.originalTarget;
                else
                    gTopBrowserWindow.gBrief.contextMenuTarget = null;
                break;
        }
    },


    _onClick: function FeedView__onClick(aEvent) {
        var target = aEvent.target;

        if (gPrefs.keyNavEnabled && target.className == 'article-container')
            gFeedView.selectEntry(target.id);

        // We can't open entry links by dispatching custom events, because for
        // whatever reason the binding handlers don't catch middle-clicks.
        var cmd = aEvent.originalTarget.getAttribute('command');

        if (cmd == 'open' && (aEvent.button == 0 || aEvent.button == 1)) {
            aEvent.preventDefault();

            // Prevent default doesn't seem to stop the default action when
            // middle-clicking, so we've got stop propagation as well.
            if (aEvent.button == 1)
                aEvent.stopPropagation();

            var openInTabs = gPrefs.getBoolPref('feedview.openEntriesInTabs');
            var newTab = (openInTabs || aEvent.button == 1);
            gCommands.openEntryLink(target, newTab);
        }
    },


    /**
     * Checks if the view is up-to-date (i.e. contains the right set of entries and
     * displays the correct title) and refreshes it if necessary.
     * Note: the visual state of entries (read/unread, starred/unstarred) is not verified
     * and it has to be maintained separately by calling onEntryMarkedRead and
     * onEntryStarred whenever it is changed.
     * Note: exhaustively comparing the old and the new entry sets would be very slow.
     * To speed things up we compare just the numbers of entries, assuming that whenever
     * the set changes, their number changes too. This assumption holds up for most of
     * our purposes. If we are not sure if that's true in a particular case, we should
     * force full refresh by passing TRUE as the parameter.
     *
     * @param aForceRefresh Forces full refresh, without checking.
     * @returns TRUE if the view was up-to-date, FALSE if it needed refreshing.
     */
    ensure: function FeedView_ensure(aForceRefresh) {
        if (!this.isActive)
            return true;

        var viewIsClean = true;

        if (aForceRefresh) {
            viewIsClean = false;
        }
        else if (!this.browser.webProgress.isLoadingDocument) {
            var oldCount = this.entriesCount;
            var currentCount = this.query.getEntriesCount();

            if (!oldCount || !currentCount || oldCount != currentCount)
                viewIsClean = false;

            // Optimize the common case when a single entry is removed.
            if (oldCount - currentCount == 1) {
                this._refreshOnEntryRemoved();
                var didPartialRefresh = true;
            }
        }

        if (!viewIsClean && !didPartialRefresh) {
            this._refresh();
        }
        else {
            var title = this.titleOverride || this.title;
            var titleElement = this.document.getElementById('feed-title');

            if (titleElement.textContent != title) {
                viewIsClean = false;
                titleElement.textContent = title;
            }
        }

        return viewIsClean;
    },


    // Refreshes the feed view from scratch.
    _refresh: function FeedView_refresh() {
        this.browser.style.cursor = 'wait';

        // Stop scrolling, so it doesn't continue after refreshing.
        clearInterval(this._smoothScrollInterval);
        this._smoothScrollInterval = null;

        // Cancel auto-marking entries as read.
        clearTimeout(this._markVisibleTimeout);

        // Suppress selecting entry until we refresh is finished.
        this._selectionSuppressed = true;

        // Load the template. The actual content building happens when the template
        // page is loaded - see _onLoad below.
        this.browser.loadURI(gTemplateURI.spec);

        // Store a list of ids of displayed entries. It is used to determine if
        // the view needs to be refreshed when database changes. This can be done
        // after timeout, so not to delay the view creation any futher.
        function setEntries() {
            gFeedView._entries = gFeedView.query.getSerializedEntries().
                                                 getPropertyAsAString('entries').
                                                 match(/[^ ]+/g);
        }
        async(setEntries, 500);
    },


    // Fast path for refreshing the view in the common case of a single
    // entry having been removed, which allows us to gracefully remove
    // just it instead of completely refreshing the view.
    _refreshOnEntryRemoved: function FeedView__refreshOnEntryRemoved() {
        var removedEntry = null;
        var removedIndex;
        var oldEntries = this._entries;
        var currentEntries = this.query.getSerializedEntries().
                                        getPropertyAsAString('entries').
                                        match(/[^ ]+/g);

        var visibleEntriesCount = this.feedContent.childNodes.length;
        if (visibleEntriesCount === 1 && currentEntries && this.currentPage === this.pageCount) {
            this.currentPage--;
        }
        else {
            // Find the removed entry.
            for (var i = 0; i < oldEntries.length; i++) {
                if (!currentEntries || currentEntries.indexOf(oldEntries[i]) === -1) {
                    removedEntry = oldEntries[i];
                    removedIndex = i;
                    break;
                }
            }

            var startPageIndex = gPrefs.entriesPerPage * (this.currentPage - 1);
            var endPageIndex = startPageIndex + gPrefs.entriesPerPage - 1;

            // If the removed entry wasn't on the current page then perform full refresh.
            if (removedIndex < startPageIndex || removedIndex > endPageIndex) {
                this._refresh();
            }
            else {
                this._removeEntry(removedEntry);
                this._entries = currentEntries;
            }
        }
    },


    // Removes an entry element from the current page and appends a new one.
    _removeEntry: function FeedView__removeEntry(aEntry) {
        var entryElement = this.document.getElementById(aEntry);

        var entryWasSelected = (aEntry == this.selectedEntry);
        if (entryWasSelected) {
            // Immediately deselect the entry, so that no futher commands can be sent.
            this.selectEntry(null);

            // Remember the next and previous siblings as we
            // may need to select one of them.
            var nextSibling = entryElement.nextSibling;
            var previousSibling = entryElement.previousSibling;
        }

        // Remove the entry. We don't do it directly, because we want to
        // use jQuery to to fade it gracefully.
        this._sendEvent(aEntry, 'DoRemoveEntry');

        var self = this;
        function finish() {
            self._computePages();

            // Pull the entry to be added to the current page, which happens
            // to have been the first entry of the next page.
            var query = self.query;
            query.offset = gPrefs.entriesPerPage * self.currentPage - 1;
            query.limit = 1;
            var newEntry = query.getEntries({})[0];

            // Append the entry. If we're on the last page then there may
            // have been no futher entries to pull.
            var appendedEntry = null;
            if (newEntry)
                appendedEntry = self._appendEntry(newEntry);

            if (!self.feedContent.childNodes.length)
                self._setEmptyViewMessage();

            // Select another entry
            if (entryWasSelected)
                self.selectEntry(nextSibling || appendedEntry || previousSibling || null);
        }

        // Don't append the new entry until the old one is removed.
        async(finish, 310);
    },


    onEntryMarkedRead: function FeedView_onEntryMarkedRead(aEntry, aNewState) {
        this._sendEvent(aEntry, 'EntryMarkedRead', aNewState);
    },


    onEntryStarred: function FeedView_onEntryStarred(aEntry, aNewState) {
        this._sendEvent(aEntry, 'EntryStarred', aNewState);
    },


    // Computes the current entries count, page counter, current page ordinal and
    // refreshes the navigation UI.
    _computePages: function FeedView__computePages() {
        this.entriesCount = this.query.getEntriesCount();
        this.pageCount = Math.ceil(this.entriesCount / gPrefs.entriesPerPage) || 1;

        // This may happen for example when you are on the last page, and the
        // number of entries decreases (e.g. they are deleted).
        if (this.currentPage > this.pageCount)
            this.__currentPage = this.pageCount;

        // Update the page commands and description
        var pageLabel = document.getElementById('page-desc');
        var prevPageButton = document.getElementById('prev-page');
        var nextPageButton = document.getElementById('next-page');

        prevPageButton.setAttribute('disabled', this.currentPage <= 1);
        nextPageButton.setAttribute('disabled', this.currentPage == this.pageCount);
        var stringbundle = document.getElementById('main-bundle');
        var params = [this.currentPage, this.pageCount];
        pageLabel.value = stringbundle.getFormattedString('pageNumberLabel', params);
    },


    // Generates and sets up the feed view page. Because we insert third-party
    // content in it (the entries are not served in plain text but in full HTML
    // markup) this page needs to be have a file:// URI to be unprivileged.
    // It is untrusted and all the interaction respects XPCNativeWrappers.
    _buildFeedView: function FeedView__buildFeedView() {
        var doc = this.document;

        // Add listeners so that the content can communicate with chrome to perform
        // actions that require full privileges by sending custom events.
        doc.addEventListener('SwitchEntryRead', this, true);
        doc.addEventListener('SwitchEntryStarred', this, true);
        doc.addEventListener('DeleteEntry', this, true);
        doc.addEventListener('RestoreEntry', this, true);
        doc.addEventListener('EntryUncollapsed', this, true);

        doc.addEventListener('click', this, true);
        doc.addEventListener('mousedown', this, true);
        doc.addEventListener('scroll', this, true);

        doc.addEventListener('keypress', onKeyPress, true);


        // Apply the CSS.
        var style = doc.getElementById('feedview-style');
        style.textContent = gFeedViewStyle;

        var feed = gStorage.getFeed(this.query.feeds);

        this._buildHeader(feed);

        this.feedContent = doc.getElementById('feed-content');

        // Attributes indicating view type, used by CSS.
        if (this.query.deleted == ENTRY_STATE_TRASHED)
            this.feedContent.setAttribute('trash', true);
        if (gPrefs.showHeadlinesOnly)
            this.feedContent.setAttribute('showHeadlinesOnly', true);

        // Pass some data which bindings need but don't have access to.
        // We can bypass XPCNW here, because untrusted content is not
        // inserted until the bindings are attached.
        var data = {};
        data.doubleClickMarks = gPrefs.doubleClickMarks;
        data.markReadString = this.markAsReadStr;
        data.markUnreadString = this.markAsUnreadStr;
        data.showFeedNames = !feed;
        this.document.defaultView.wrappedJSObject.gConveyedData = data;

        var query = this.query;
        query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
        query.limit = gPrefs.entriesPerPage;

        var entries = query.getEntries({});

        // Important: for better performance we try to delay computing pages until
        // after the view is displayed.
        // The only time when recomputing pages may affect the currently displayed
        // entry set is when currentPage goes out of range, because the view contains
        // less pages than before. This in turn makes the offset invalid and the query
        // returns no entries.
        // To avoid that, whenever the query returns no entries we force immediate
        // recomputation of pages to make sure that they are correct and then we redo
        // the query.
        if (!entries.length) {
            this._computePages();
            query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
            query.limit = gPrefs.entriesPerPage;
            entries = query.getEntries({});
        }
        else {
            async(this._computePages, 500, this);
        }

        for (var i = 0; i < entries.length; i++)
            this._appendEntry(entries[i]);

        if (!entries.length)
            this._setEmptyViewMessage();

        this._initSelection()

        this.markVisibleAsRead();

        this.browser.style.cursor = 'auto';
    },


    _buildHeader: function FeedView__buildHeader(aFeed) {
        var doc = this.document

        var titleElement = doc.getElementById('feed-title');
        titleElement.textContent = this.titleOverride || this.title;

        // When a single unfiltered feed is viewed, add the subtitle,
        // the image, and the link.
        if (aFeed && !this.searchString) {
            var header = doc.getElementById('header');
            header.setAttribute('href', aFeed.websiteURL ? aFeed.websiteURL : aFeed.feedURL);

            if (aFeed.imageURL) {
                var feedImage = doc.getElementById('feed-image');
                feedImage.setAttribute('src', aFeed.imageURL);
                feedImage.setAttribute('title', aFeed.imageTitle);
            }

            if (aFeed.subtitle)
                doc.getElementById('feed-subtitle').innerHTML = aFeed.subtitle;
        }
    },


    _appendEntry: function FeedView__appendEntry(aEntry) {
        var articleContainer = this.document.createElementNS(XHTML_NS, 'div');
        articleContainer.className = 'article-container';

        // Safely pass the data so that binding constructor can use it.
        articleContainer.setAttribute('id', aEntry.id);
        articleContainer.setAttribute('entryURL', aEntry.entryURL);
        articleContainer.setAttribute('entryTitle', aEntry.title);
        articleContainer.setAttribute('content', aEntry.content);

        if (gPrefs.showAuthors && aEntry.authors)
            articleContainer.setAttribute('authors', this.authorPrefixStr + aEntry.authors);
        if (aEntry.read)
            articleContainer.setAttribute('read', true);
        if (aEntry.starred)
            articleContainer.setAttribute('starred', true);

        if (aEntry.date) {
            var dateString = this._constructEntryDate(aEntry);
            articleContainer.setAttribute('date', dateString);

            if (aEntry.updated) {
                dateString += ' <span class="article-updated">' + this.updatedStr + '</span>'
                articleContainer.setAttribute('updated', dateString);
            }
        }

        var feedName = gStorage.getFeed(aEntry.feedID).title;
        articleContainer.setAttribute('feedName', feedName);

        if (gPrefs.showHeadlinesOnly)
            articleContainer.setAttribute('collapsed', true);

        this.feedContent.appendChild(articleContainer);

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


    _setEmptyViewMessage: function FeedView__setEmptyViewMessage() {
        var paragraph = this.document.getElementById('message');
        var bundle = document.getElementById('main-bundle');
        var message;

        if (this.query.searchString)
            message = bundle.getString('noEntriesFound');
        else if (this.query.unread)
            message = bundle.getString('noUnreadEntries');
        else if (this.query.starred && this._flagsAreIntrinsic)
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


    _initSelection: function FeedView__initSelection() {
        this._selectionSuppressed = false;

        if (gPrefs.keyNavEnabled) {

            if (this.selectedElement) {
                this.selectEntry(this.selectedEntry, true);
            }
            else if (this._selectLastEntryOnRefresh) {
                entry = this.feedContent.lastChild;
                this.selectEntry(entry, true);
            }
            else {
                entry = this.feedContent.firstChild;
                this.selectEntry(entry);
            }

            this._selectLastEntryOnRefresh = false;
        }
    }

}
