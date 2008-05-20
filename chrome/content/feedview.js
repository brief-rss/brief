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


    get browser FeedView_browser() {
        delete this.__proto__.browser;
        return this.__proto__.browser = getElement('feed-view');
    },

    get document FeedView_document() {
        return this.browser.contentDocument;
    },

    feedContent: null,


    // Query that selects entries contained by the view. It is set to to retrieve
    // all the entries, not only the ones displayed on the current page.
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

    // It's much faster to retrieve entries by their IDs if we know them,
    // we keep a separate query for that.
    get _fastQuery FeedView_fastQuery() {
        if (!this.__fastQuery) {
            this.__fastQuery = new Query();
            this.__fastQuery.sortOrder = this.query.sortOrder;
            this.__fastQuery.sortDirection = this.query.sortDirection;
        }
        return this.__fastQuery;
    },


    // Ordered array IDs of entries that the view contains.
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
            this.refresh(true);
        }
    },

    get currentPage FeedView_currentPage_get() {
        // currentPage may have gone out of range if the number of entries decreased.
        if (this.__currentPage > this.pageCount)
            this.__currentPage = this.pageCount;
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

    _getVisibleEntryIDs: function FeedView__getVisibleEntryIDs() {
        let pageStartIndex = gPrefs.entriesPerPage * (this.currentPage - 1);
        let pageEndIndex = pageStartIndex + gPrefs.entriesPerPage - 1;
        return this._entries.slice(pageStartIndex, pageEndIndex + 1);
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
                this.selectEntry(parseInt(entryElement.id), true, true);
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
                this.selectEntry(parseInt(entryElement.id), true, true);
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
        if (!this.isActive)
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
        var win = this.document.defaultView;
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

        // Disallow selecting further entries until scrolling is finished.
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


    // This array stores the list of entries marked as unread by the user. They become
    // excluded from auto-marking, in order to prevent them from being immediately
    // re-marked as read when autoMarkRead is on.
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
            let id = parseInt(entries[i].id);
            let wasMarkedUnread = (this.entriesMarkedUnread.indexOf(id) != -1);

            if ((entryTop >= winTop) && (entryTop < winBottom - 50) && !wasMarkedUnread)
                entriesToMark.push(id);
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
        if (!this.query.searchString && searchbar.searchInProgress) {
            searchbar.searchInProgress = false;
            searchbar.clear();
        }

        // Hide the drop-down to pick view constraints if it is tied to
        // specific constraints (e.g. the Unread folder).
        getElement('view-constraint-box').hidden = this._flagsAreIntrinsic;

        this.browser.addEventListener('load', this, false);
        gStorage.addObserver(this);

        if (this.browser.currentURI.equals(gTemplateURI)) {
            // This has to be done also here (not only in onload), because load event
            // wasn't sent if the page had been restored by SessionStore.
            this._setupTemplatePage();

            // Do it asynchronously, because UI maybe waiting to be redrawn
            // (e.g. after selecting a treeitem).
            async(this.refresh, 0, this, false);
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

        gStorage.removeObserver(this);

        clearInterval(this._smoothScrollInterval);
        this._smoothScrollInterval = null;
        clearTimeout(this._markVisibleTimeout);

        gFeedView = null;
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


    // Events to which we listen in the template page. Entry binding communicates with
    // chrome to perform actions that require full privileges by sending custom events.
    _events: ['SwitchEntryRead', 'SwitchEntryStarred', 'ShowBookmarkPopup',
              'DeleteEntry', 'RestoreEntry', 'EntryUncollapsed', 'ShowBookmarkPanel',
              'click', 'mousedown', 'scroll', 'keypress'],

    handleEvent: function FeedView_handleEvent(aEvent) {
        var target = aEvent.target;
        var id = parseInt(target.id);

        switch (aEvent.type) {

            // Forward commands from the view to the controller.
            case 'SwitchEntryRead':
                var newState = !target.hasAttribute('read');
                gCommands.markEntryRead(id, newState);
                break;
            case 'DeleteEntry':
                gCommands.deleteEntry(id);
                break;
            case 'RestoreEntry':
                gCommands.restoreEntry(id);
                break;
            case 'SwitchEntryStarred':
                var newState = !target.hasAttribute('starred');
                gCommands.starEntry(id, newState);
                break;
            case 'EntryUncollapsed':
                if (gPrefs.autoMarkRead && !this.query.unread)
                    gCommands.markEntryRead(id, true);
                break;
            case 'ShowBookmarkPanel':
                let query = new Query();
                query.entries = [id];
                let itemID = query.getProperty('bookmarkID')[0].bookmarkID;

                let starElem = this._getAnonElement(target.firstChild, 'star-article');
                gTopWindow.StarUI.showEditBookmarkPopup(itemID, starElem, 'after_start');
                break;

            case 'load':
                getElement('feed-view-toolbar').hidden = !this.isActive;
                if (this.isActive) {
                    this._setupTemplatePage();
                    this.refresh();
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
            gFeedView.selectEntry(parseInt(entryElement.id));

        // We intercept clicks on the article title link, so that we can mark the entry as
        // read and force opening in a new tab if necessary. We can't dispatch a custom
        // event like we do with other actions, because for whatever reason the binding
        // handlers don't catch middle-clicks.
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

    // nsIBriefStorageObserver
    onEntriesAdded: function FeedView_onEntriesAdded(aEntryList) {
        if (this.query.deleted === ENTRY_STATE_NORMAL)
            this._ensure(aEntryList.IDs, true);
    },

    // nsIBriefStorageObserver
    onEntriesUpdated: function FeedView_onEntriesUpdated(aEntryList) {
        var refreshed = this.query.unread ? this._ensure(aEntryList.IDs, true) : false;

        var visibleEntries = intersect(this._getVisibleEntryIDs(), aEntryList.IDs);
        if (!refreshed && visibleEntries.length)
            this.refresh(true);
    },

    // nsIBriefStorageObserver
    onEntriesMarkedRead: function FeedView_onEntriesMarkedRead(aEntryList, aNewState) {
        var refreshed = this.query.unread ? this._ensure(aEntryList.IDs, !aNewState)
                                          : false;

        if (!refreshed && this.isActive) {
            let entries = intersect(this._getVisibleEntryIDs(), aEntryList.IDs);
            this._sendEvent(entries, 'EntryMarkedRead', aNewState);
        }
    },

    // nsIBriefStorageObserver
    onEntriesStarred: function FeedView_onEntriesStarred(aEntryList, aNewState) {
        var refreshed = this.query.starred ? this._ensure(aEntryList.IDs, aNewState)
                                           : false;

        if (!refreshed && this.isActive) {
            let entries = intersect(this._getVisibleEntryIDs(), aEntryList.IDs);
            this._sendEvent(entries, 'EntryStarred', aNewState);
        }
    },

    // nsIBriefStorageObserver
    onEntriesTagged: function FeedView_onEntriesTagged(aEntryList, aNewState, aTag) {
        var refreshed = false;
        if (this.query.tags && this.query.tags[0] === aTag)
            refreshed = this._ensure(aEntryList.IDs, aNewState);

        if (refreshed || !this.isActive)
            return;

        for (let i = 0; i < aEntryList.IDs.length; i++) {
            let id = aEntryList.IDs[i];
            let elem = this.document.getElementById(id);
            if (elem) {
                elem.setAttribute('changedTag', aTag);
                this._sendEvent(id, 'EntryTagged', aNewState);
            }
        }
    },

    // nsIBriefStorageObserver
    onEntriesDeleted: function FeedView_onEntriesDeleted(aEntryList, aNewState) {
        this._ensure(aEntryList.IDs, false);
    },


    /**
     * Checks if the contained set of entries is should change and chooses the
     * best way to refresh it.
     *
     * @param aModifiedEntries Array of modified entries.
     * @param aPotentialChange TRUE if the modified entries should potentially be added,
     *                         FALSE if they may need to be removed.
     *
     * @returns TRUE if the entry set was valid, FALSE if it wasn't and the view was
     *          refreshed.
     */
    _ensure: function FeedView__ensure(aModifiedEntries, aPotentialChange) {
        var refreshed = false;

        if (aPotentialChange) {
            if (this.entryCount != this.query.getEntryCount()) {
                if (this.isActive && !this.browser.webProgress.isLoadingDocument)
                    this.refresh();
                else
                    async(this._refreshEntryList, 250, this);

                refreshed = true;
            }
        }
        else {
            var entriesToRemove = intersect(aModifiedEntries, this._entries);
            if (entriesToRemove.length) {

                // We optimize the case of cutting a single entry from the current page
                // by gracefully removing just it instead doing a full refresh.
                if (entriesToRemove.length === 1) {
                    var removedEntry = entriesToRemove[0];

                    let visibleEntries = this._getVisibleEntryIDs();
                    var isVisible = visibleEntries.indexOf(removedEntry) !== -1;

                    let removedIndex =  this._entries.indexOf(removedEntry);
                    var isLast = removedIndex === this.entryCount - 1 &&
                                 this.feedContent.childNodes.length === 1;
                }

                // Cut the removed indices from the entry set.
                var filter = function(en) entriesToRemove.indexOf(en) === -1;
                this._entries = this._entries.filter(filter);

                if (removedEntry && !isLast && isVisible)
                    this._removeEntry(removedEntry);
                else
                    this.refresh(true);

                refreshed = true;
            }
        }

        return refreshed;
    },


    /**
     * Refreshes the feed view. Removes the old content and builds the new one.
     *
     * @param aEntrySetValid Optional. Indicates that the contained set of entries isn't
     *                       expected to have changed and doesn't have to be recomputed.
     *                       In practice, it is used when switching pages.
     */
    refresh: function FeedView_refresh(aEntrySetValid) {
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

        var entries = [];

        // If the entry set hasn't changed, we can pull the entries using
        // their IDs, which is a big performance win.
        if (aEntrySetValid) {
            this._refreshPageNavUI();

            let entryIDs = this._getVisibleEntryIDs();
            if (entryIDs.length) {
                this._fastQuery.entries = entryIDs;
                entries = this._fastQuery.getFullEntries();
            }
        }
        else {
            let query = this.query;
            query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
            query.limit = gPrefs.entriesPerPage;
            entries = query.getFullEntries();

            // For better performance we try to refresh the entry list asynchronously.
            // However, sometimes we have to refresh it immediately to correctly pick
            // entries to display the current page. It occurs when currentPage goes out of
            // range, because the view contains less pages than before. The offset goes
            // out of range too and the query returns no entries. Therefore, whenever the
            // query returns no entries, we refresh the entry list immediately and then
            // redo the query.
            if (!entries.length) {
                this._refreshEntryList();
                query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
                entries = query.getFullEntries();
            }
            else {
                async(this._refreshEntryList, 250, this);
            }
        }

        // Append the entries.
        entries.forEach(this._appendEntry, this);

        if (entries.length) {
            this.document.getElementById('message').style.display = 'none';

            // Highlight search terms.
            if (this.query.searchString) {
                for each (term in this.query.searchString.match(/[A-Za-z0-9]+/g))
                    this._highlightText(term, this.feedContent);
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

        // Send an event to have the element gracefully removed by jQuery.
        this._sendEvent(aEntry, 'DoRemoveEntry');

        // Wait until the old entry is removed and append a new one. If the current page
        // is the last one then there may be no further entries.
        async(function() {
            var pageEndIndex = gPrefs.entriesPerPage * (this.currentPage - 1)
                               + gPrefs.entriesPerPage - 1;
            var entryID = this._entries[pageEndIndex];
            if (entryID) {
                this._fastQuery.entries = [entryID];
                let entry = this._fastQuery.getFullEntries()[0];
                var appendedElement = this._appendEntry(entry);
            }
            else if (!this.feedContent.childNodes.length) {
                this._setEmptyViewMessage();
            }

            if (entryWasSelected)
                this.selectEntry(nextSibling || appendedElement || previousSibling || null);

        }, 250, this);
    },

    /**
     * Refreshes the list of IDs of contained entries (also needed for entryCount
     * and pageCount), the current page number, and the navigation UI.
     */
    _refreshEntryList: function FeedView__refreshEntryList() {
        this._entries = this.query.getEntries();
        this._refreshPageNavUI();
    },

    _refreshPageNavUI: function FeedView__refreshPageNavUI() {
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

        // When a single feed is shown, add subtitle, image, and link.
        if (aFeed) {
            // Don't linkify the title when searching.
            if (!this.query.searchString) {
                feedTitle.setAttribute('href', aFeed.websiteURL || aFeed.feedURL);
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
        articleContainer.setAttribute('tags', aEntry.tags);

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

        // Highlight search terms in the anonymous content.
        if (this.query.searchString) {
            let header = articleContainer.firstChild;
            let tags = this._getAnonElement(header, 'article-tags');
            let authors = this._getAnonElement(header, 'article-authors');
            let terms = this.query.searchString.match(/[A-Za-z0-9]+/g);
            for each (term in terms) {
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


    get _finder FeedView__finder() {
        if (!this.__finder) {
            this.__finder = Cc['@mozilla.org/embedcomp/rangefind;1'].
                            createInstance(Ci.nsIFind);
            this.__finder.caseSensitive = false;
        }
        return this.__finder;
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

        var retRange;
        while (retRange = this._finder.Find(aWord, searchRange, startPoint, endPoint)) {
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
            aIID.equals(Ci.nsIEventHandler) ||
            aIID.equals(Ci.nsIBriefStorageObserver)) {
            return this;
        }
        throw Components.results.NS_ERROR_NO_INTERFACE;
    }

}
