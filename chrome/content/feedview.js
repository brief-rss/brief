/**
 * The instance of FeedView currently attached to the browser.
 */
var gFeedView = null;

/**
 * This object represents the main feed display. It stores and manages display parameters.
 * The feed displayed using a local, unprivileged template page. We insert third-party
 * content in it (entries are served with full HTML markup), so the template page is
 * untrusted and we respect XPCNativeWrappers when interacting with it.
 * Individual entries are inserted dynamically. Their structure and behaviour is defined
 * by an XBL binding.
 *
 * @param aTitle  Title of the view which will be shown in the header.
 * @param aQuery  Query which selects contained entries.
 */
function FeedView(aTitle, aQuery) {
    this.title = aTitle;

    this._flagsAreIntrinsic = aQuery.read || aQuery.unread || aQuery.starred ||
                              aQuery.unstarred || aQuery.deleted != ENTRY_STATE_NORMAL;
    this.query = aQuery;
    this.query.sortOrder = Ci.nsIBriefQuery.SORT_BY_DATE;
    if (this.query.unread && gPrefs.sortUnreadViewOldestFirst)
        this.query.sortDirection = Ci.nsIBriefQuery.SORT_ASCENDING;

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

    // Key elements.
    get browser FeedView_browser() {
        delete this.__proto__.browser;
        return this.__proto__.browser = getElement('feed-view');
    },

    get document FeedView_document() {
        return this.browser.contentDocument;
    },

    feedContent: null,


    // Query that selects entries contained by the view. It is the query to pull ALL the
    // entries, not only the ones displayed on the current page.
    set query FeedView_query_set(aQuery) {
        return this.__query = aQuery;
    },

    get query FeedView_query_get() {
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


    // IDs of contained entries, used to determine when the view needs to be refreshed.
    _entries: [],

    get entryCount Feedview_entryCount() {
        return this._entries.length;
    },

    get pageCount FeedView_pageCount() {
        return Math.max(Math.ceil(this.entryCount / gPrefs.entriesPerPage), 1);
    },

    __currentPage: 1,

    set currentPage FeedView_currentPage_set(aPage) {
        if (aPage != this.__currentPage && aPage <= this.pageCount && aPage > 0) {
            this.__currentPage = aPage;
            this._refresh(false);
        }
    },

    get currentPage FeedView_currentPage_get() {
        return this.__currentPage;
    },


    // Indicates whether the feed view is currently displayed in the browser.
    get isActive FeedView_isActive() {
        return (this.browser.currentURI.equals(gTemplateURI) && gFeedView == this);
    },

    get isGlobalSearch FeedView_isGlobalSearch() {
        return !this.query.folders && !this.query.feeds && !this._flagsAreIntrinsic
               && this.query.searchString;
    },

    get isViewSearch FeedView_isGlobalSearch() {
        return (this.query.folders || this.query.feeds || this._flagsAreIntrinsic)
               && this.query.searchString;
    },


    collapseEntry: function FeedView_collapseEntry(aEntry, aNewState, aAnimate) {
        var eventType = aAnimate ? 'DoCollapseEntryAnimated' : 'DoCollapseEntry';
        this._sendEvent(aEntry, eventType, aNewState);
    },


    /**
     * Sends an event to an entry element on the current page, for example a message to
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

    get selectedElement FeedView_selectedElement() {
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

        if (gPrefs.entrySelectionEnabled) {
            var entryElement = this.selectedElement.nextSibling;
            if (entryElement)
                this.selectEntry(entryElement.id, true, true);
            else
                this.currentPage++;
        }
        else {
            gPrefs.setBoolPref('feedview.entrySelectionEnabled', true);
        }
    },

    selectPrevEntry: function FeedView_selectPrevEntry() {
        if (this._selectionSuppressed)
            return;

        if (gPrefs.entrySelectionEnabled) {
            var entryElement = this.selectedElement.previousSibling;
            if (entryElement) {
                this.selectEntry(entryElement.id, true, true);
            }
            // Normally we wouldn't have to check |currentPage > 1|, because
            // the setter validates its input. However, we don't want to set
            // _selectLastEntryOnRefresh and then not refresh.
            else if (this.currentPage > 1) {
                this._selectLastEntryOnRefresh = true;
                this.currentPage--;
            }
        }
        else {
            gPrefs.setBoolPref('feedview.entrySelectionEnabled', true);
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

        targetPosition = Math.max(targetPosition, 0);
        targetPosition = Math.min(targetPosition, win.scrollMaxY);

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
        with (Math) {
            var absoluteJump = round(abs(delta) / 10);
            absoluteJump = max(absoluteJump, 15);
            absoluteJump = min(absoluteJump, 150);
            var jump = (delta > 0) ? absoluteJump : -absoluteJump;
        }

        // Disallow selecting futher entries until scrolling is finished.
        this._selectionSuppressed = true;
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

        this._smoothScrollInterval = setInterval(scroll, 10);
    },


    // Return the entry element closest to the middle of the screen.
    _getMiddleEntryElement: function FeedView__getMiddleEntryElement() {
        var elems = this.feedContent.childNodes;
        if (!elems.length)
            return null;

        var win = this.document.defaultView;
        var middleLine = win.pageYOffset + Math.round(win.innerHeight / 2);

        // Get the element in the middle of the screen.
        for (var i = 0; i < elems.length - 1; i++) {
            if ((elems[i].offsetTop <= middleLine) && (elems[i + 1].offsetTop > middleLine)) {
                var middleElement = elems[i];
                break;
            }
        }

        return middleElement || elems[elems.length - 1];
    },


    toggleEntrySelection: function FeedView_toggleEntrySelection() {
        if (gPrefs.entrySelectionEnabled)
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
        var entries = this.feedContent.childNodes;

        var entriesToMark = [];

        for (let i = 0; i < entries.length; i++) {
            let entryTop = entries[i].offsetTop;
            let wasMarkedUnread = (this.entriesMarkedUnread.indexOf(entries[i].id) != -1);

            if ((entryTop >= winTop) && (entryTop < winBottom - 50) && !wasMarkedUnread)
                entriesToMark.push(entries[i].id);
        }

        if (entriesToMark.length) {
            var query = new QuerySH(null, entriesToMark, false);
            query.markEntriesRead(true);
        }
    },


    /**
     * Displays the view, adds it as the listener for events in the template page,
     * and sets it as the currently attached instance - under gFeedView.
     */
    attach: function FeedView_attach() {
        if (gFeedView)
            gFeedView.detach();
        gFeedView = this;

        // Clear the searchbar.
        var searchbar = getElement('searchbar');
        if (!this.query.searchString && searchbar.value) {
            searchbar.value = '';
            searchbar.clearButton.hidden = true;
        }

        // Hide the drop-down to pick view contraints if it is tied to
        // specific contraints (e.g. the Unread folder).
        getElement('view-constraint-box').hidden = this._flagsAreIntrinsic;

        this.browser.addEventListener('load', this, false);

        if (this.browser.currentURI.equals(gTemplateURI)) {
            // This has to be done also here (not only in onload), because load event
            // wasn't sent if the page had been restored by SessionStore.
            this._setupTemplatePage();

            // Do it asynchronously, because UI maybe waiting to be redrawn
            // (e.g. after selecting a treeitem).
            async(this._refresh, 0, this, true);
        }
        else {
            this.browser.loadURI(gTemplateURI.spec);
        }
    },

    /**
     * Removes the view as the listener, cancels pending actions.
     */
    detach: function FeedView_detach() {
        this.browser.removeEventListener('load', this, false);
        for each (event in this._events)
            this.document.removeEventListener(event, this, true);

        clearInterval(this._smoothScrollInterval);
        this._smoothScrollInterval = null;
        clearTimeout(this._markVisibleTimeout);

        gFeedView = null;
    },


    // Events to which we listen to in the template page. Entry binding communicates with
    // chrome to perform actions that require full privileges by sending custom events.
    _events: ['SwitchEntryRead', 'SwitchEntryStarred', 'ShowBookmarkPopup',
              'DeleteEntry', 'RestoreEntry', 'EntryUncollapsed', 'click',
              'mousedown', 'scroll', 'keypress'],

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
                getElement('feed-view-toolbar').hidden = !this.isActive;

                if (this.isActive) {
                    this._setupTemplatePage();
                    this._refresh(true);
                }
                break;

            case 'scroll':
                this.markVisibleAsRead();
                break;
            case 'click':
                this._onClick(aEvent);
                break;
            case 'keypress':
                onKeyPress(aEvent);
                break;
        }
    },


    _onClick: function FeedView__onClick(aEvent) {
        // Look for the article container in the target's parent chain.
        var elem = aEvent.target;
        while (elem != this.document.documentElement) {
            if (elem.className == 'article-container') {
                var entryElement = elem;
                break;
            }
            elem = elem.parentNode;
        }

        if (gPrefs.entrySelectionEnabled && entryElement)
            gFeedView.selectEntry(entryElement.id);

        // We intercept clicks on the article title link, so that we can mark the
        // entry as read and force opening in a new tab if necessary. We can't
        // dispatch a custom event like we do with other actions, because for
        // whatever reason the binding handlers don't catch middle-clicks.
        if (aEvent.target.className == 'article-title-link'
            && (aEvent.button == 0 || aEvent.button == 1)) {

            aEvent.preventDefault();

            // Prevent default doesn't seem to stop the default action when
            // middle-clicking, so we've got stop propagation as well.
            if (aEvent.button == 1)
                aEvent.stopPropagation();

            var openInTabs = gPrefs.getBoolPref('feedview.openEntriesInTabs');
            var newTab = (openInTabs || aEvent.button == 1);
            gCommands.openEntryLink(entryElement, newTab);
        }
    },


    // This function sets up the page after it's loaded or after attaching a new FeedView.
    // It does the initial work, which doesn't have to be done every time when refreshing.
    _setupTemplatePage: function FeedView__setupTemplatePage() {
        for each (event in this._events)
            this.document.addEventListener(event, this, true);

        // Pass some data which bindings need but don't have access to.
        // We can bypass XPCNW here, because untrusted content is not
        // inserted until the bindings are attached.
        var data = {};
        data.doubleClickMarks = gPrefs.doubleClickMarks;
        data.markReadString = this.markAsReadStr;
        data.markUnreadString = this.markAsUnreadStr;
        this.document.defaultView.wrappedJSObject.gConveyedData = data;
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
        if (aForceRefresh) {
            this._refresh(true);
            return false;
        }

        var oldCount = this.entryCount;
        var currentCount = this.query.getEntryCount();

        if (!oldCount || !currentCount || oldCount != currentCount) {

            // If a different page is shown, we don't have to refresh the page,
            // but we still need to update the entry list.
            if (!this.isActive || this.browser.webProgress.isLoadingDocument)
                this._refreshEntryList();
            else if (oldCount - currentCount == 1)
                this._refreshOnEntryRemoved();
            else
                this._refresh(true);

            return false;
        }

        var title = this.titleOverride || this.title;
        var titleElement = this.document.getElementById('feed-title');
        if (titleElement.textContent != title) {
            titleElement.textContent = title;
            return false;
        }

        return true;
    },


    /**
     * Refreshes the feed view. Removes the old content and builds the new one.
     *
     * @param aEntrySetModified Indicates that the set of entries in the view
     *                          was changed and has to be recomputed.
     */
    _refresh: function FeedView_refresh(aEntrySetModified) {
        // Stop scrolling.
        clearInterval(this._smoothScrollInterval);
        this._smoothScrollInterval = null;

        // Cancel auto-marking entries as read timeout.
        clearTimeout(this._markVisibleTimeout);

        // Remove the old content.
        var container = this.document.getElementById('container');
        var oldContent = this.document.getElementById('feed-content');
        container.removeChild(oldContent);

        this.feedContent = this.document.createElement('div');
        this.feedContent.id = 'feed-content';
        container.appendChild(this.feedContent);

        var feed = gStorage.getFeed(this.query.feeds);

        this._buildHeader(feed);

        // Pass parameters to the content.
        if (this.query.deleted == ENTRY_STATE_TRASHED)
            this.feedContent.setAttribute('trash', true);
        if (gPrefs.showHeadlinesOnly)
            this.feedContent.setAttribute('showHeadlinesOnly', true);
        if (!feed)
            this.feedContent.setAttribute('showFeedNames', true);

        var query = this.query;
        query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
        query.limit = gPrefs.entriesPerPage;
        var entries = query.getEntries();

        // For better performance we try to refresh the entry list (and the navigation UI)
        // asynchronously.
        // However, sometimes the list has to be refreshed immediately, because it is
        // required to correctly display the current page. It occurs when currentPage
        // goes out of range, because the view contains less pages than before.
        // The offset goes out of range too and the query returns no entries. Therefore,
        // whenever the query returns no entries, we refresh the entry list immediately
        // and then redo the query.
        if (!entries.length) {
            this._refreshEntryList();
            query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
            entries = query.getEntries();
        }
        else {
            if (aEntrySetModified)
                async(this._refreshEntryList, 250, this);
            else
                this._refreshPageNavUI();
        }

        // Append the entries.
        for (var i = 0; i < entries.length; i++)
            this._appendEntry(entries[i]);

        if (entries.length) {
            this.document.getElementById('message').style.display = 'none';

            // Highlight the search terms.
            if (this.query.searchString) {
                for each (word in this.query.searchString.match(/[A-Za-z0-9]+/g))
                    this._highlightText(word);
            }
        }
        else {
            this._setEmptyViewMessage();
        }

        // Initialize selection.
        if (gPrefs.entrySelectionEnabled) {
            if (this.selectedElement)
                var entryElement = this.selectedElement;
            else if (this._selectLastEntryOnRefresh)
                entryElement = this.feedContent.lastChild;
            else
                entryElement = this.feedContent.firstChild;

            this.selectEntry(entryElement, true);
            this._selectLastEntryOnRefresh = false;
        }
        else {
            var win = this.document.defaultView;
            win.scroll(win.pageXOffset, 0);
        }

        this.markVisibleAsRead();
    },


    // Fast path for refreshing the view in the common case of a single
    // entry having been removed, which allows us to gracefully remove
    // just it instead of completely refreshing the view.
    _refreshOnEntryRemoved: function FeedView__refreshOnEntryRemoved() {
        var oldEntries = this._entries;
        this._refreshEntryList();
        var currentEntries = this._entries;

        if (this.feedContent.childNodes.length === 1 && currentEntries
            && this.currentPage === this.pageCount) {
            // If the last remaining entry on this page was removed,
            // do a full refresh to display the previous page.
            this._refresh(true);
        }
        else {
            // Find the removed entry.
            for (var i = 0; i < oldEntries.length; i++) {
                if (!currentEntries || currentEntries.indexOf(oldEntries[i]) === -1) {
                    var removedEntry = oldEntries[i];
                    var removedIndex = i;
                    break;
                }
            }

            var startPageIndex = gPrefs.entriesPerPage * (this.currentPage - 1);
            var endPageIndex = startPageIndex + gPrefs.entriesPerPage - 1;

            if (removedIndex < startPageIndex || removedIndex > endPageIndex)
                this._refresh(true);
            else
                this._removeEntry(removedEntry);
        }
    },


    // Removes an entry element from the current page and appends a new one.
    _removeEntry: function FeedView__removeEntry(aEntry) {
        var entryElement = this.document.getElementById(aEntry);

        var entryWasSelected = (aEntry == this.selectedEntry);
        if (entryWasSelected) {
            // Immediately deselect the entry, so that no commands can be sent to it.
            this.selectEntry(null);

            // Remember these entry elements as we may need to select one of them.
            var nextSibling = entryElement.nextSibling;
            var previousSibling = entryElement.previousSibling;
        }

        // Remove the entry. We don't do it directly, because we want to
        // use jQuery to to fade it gracefully.
        this._sendEvent(aEntry, 'DoRemoveEntry');

        // Wait until the old entry is removed and append a new one.
        async(finish, 310);

        var self = this;
        function finish() {
            // Pull the entry to be added to the current page. If we're
            // on the last page then there may be no new entry.
            var query = self.query;
            query.offset = gPrefs.entriesPerPage * self.currentPage - 1;
            query.limit = 1;
            var newEntry = query.getEntries()[0];

            if (newEntry)
                var appendedEntry = self._appendEntry(newEntry);

            if (!self.feedContent.childNodes.length)
                self._setEmptyViewMessage();

            // Select another entry.
            if (entryWasSelected)
                self.selectEntry(nextSibling || appendedEntry || previousSibling || null);
        }
    },


    onEntryMarkedRead: function FeedView_onEntryMarkedRead(aEntry, aNewState) {
        this._sendEvent(aEntry, 'EntryMarkedRead', aNewState);
    },


    onEntryStarred: function FeedView_onEntryStarred(aEntry, aNewState) {
        this._sendEvent(aEntry, 'EntryStarred', aNewState);
    },


    /**
     * Refreshes the list of IDs of contained entries (also needed for entryCount
     * and pageCount), the current page number, and the navigation UI.
     */
    _refreshEntryList: function FeedView__refreshEntryList() {
        this._entries = this.query.getSimpleEntryList().getProperty('entries');
        this._refreshPageNavUI();
    },

    _refreshPageNavUI: function FeedView__refreshPageNavUI() {
        // The current page may go out of range if the number of entries decreases.
        this.currentPage = Math.min(this.currentPage, this.pageCount);

        var prevPageButton = getElement('prev-page');
        var nextPageButton = getElement('next-page');
        prevPageButton.setAttribute('disabled', this.currentPage <= 1);
        nextPageButton.setAttribute('disabled', this.currentPage == this.pageCount);

        var stringbundle = getElement('main-bundle');
        var params = [this.currentPage, this.pageCount];
        var pageLabel = getElement('page-desc');
        pageLabel.value = stringbundle.getFormattedString('pageNumberLabel', params);
    },


    _buildHeader: function FeedView__buildHeader(aFeed) {
        var header = this.document.getElementById('header');
        var feedTitle = this.document.getElementById('feed-title');
        var feedImage = this.document.getElementById('feed-image');
        var feedSubtitle = this.document.getElementById('feed-subtitle');

        // Reset the old header.
        feedTitle.removeAttribute('href');
        feedTitle.className = '';
        feedImage.setAttribute('src', '');
        feedImage.removeAttribute('title');
        feedSubtitle.innerHTML = '';

        feedTitle.textContent = this.titleOverride || this.title;

        // When a single unfiltered feed is viewed, add subtitle, image, and link.
        if (aFeed) {
            var link = aFeed.websiteURL || aFeed.feedURL;
            if (link) {
                feedTitle.setAttribute('href', link);
                feedTitle.className = 'feed-link';
            }

            if (aFeed.imageURL) {
                feedImage.setAttribute('src', aFeed.imageURL);
                feedImage.setAttribute('title', aFeed.imageTitle);
            }

            if (aFeed.subtitle)
                feedSubtitle.innerHTML = aFeed.subtitle;
        }
    },


    _appendEntry: function FeedView__appendEntry(aEntry) {
        var articleContainer = this.document.createElement('div');
        articleContainer.className = 'article-container';

        // Safely pass the data so that binding constructor can use it.
        articleContainer.setAttribute('id', aEntry.id);
        articleContainer.setAttribute('entryURL', aEntry.entryURL);
        articleContainer.setAttribute('entryTitle', aEntry.title);
        articleContainer.setAttribute('content', aEntry.content);

        if (aEntry.authors)
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
        var bundle = getElement('main-bundle');
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


    _highlightText: function FeedView__highlightText(aWord) {
        var finder = Cc['@mozilla.org/embedcomp/rangefind;1'].
                     createInstance(Ci.nsIFind);
        finder.caseSensitive = false;

        var searchRange = this.document.createRange();
        searchRange.setStart(this.feedContent, 0);
        searchRange.setEnd(this.feedContent, this.feedContent.childNodes.length);

        var startPoint = this.document.createRange();
        startPoint.setStart(this.feedContent, 0);
        startPoint.setEnd(this.feedContent, 0);

        var endPoint = this.document.createRange();
        endPoint.setStart(this.feedContent, this.feedContent.childNodes.length);
        endPoint.setEnd(this.feedContent, this.feedContent.childNodes.length);

        var baseNode = this.document.createElement('span');
        baseNode.className = 'search-highlight';

        var retRange;
        while (retRange = finder.Find(aWord, searchRange, startPoint, endPoint)) {
            let surroundingNode = baseNode.cloneNode(false);
            surroundingNode.appendChild(retRange.extractContents());

            let before = retRange.startContainer.splitText(retRange.startOffset);
            before.parentNode.insertBefore(surroundingNode, before);

            startPoint.setStart(surroundingNode, surroundingNode.childNodes.length);
            startPoint.setEnd(surroundingNode, surroundingNode.childNodes.length);
        }
    }

}
