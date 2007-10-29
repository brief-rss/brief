const XHTML_NS = 'http://www.w3.org/1999/xhtml';

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

    // Clear the searchbar.
    if (!aQuery.searchString) {
        var searchbar = document.getElementById('searchbar');
        searchbar.setAttribute('showingDescription', true);
    }

    this.browser = document.getElementById('feed-view');
    this.document = this.browser.contentDocument;

    // If view is tied to specified intrinsic flags (e.g. special "Unread" view), hide
    // the UI to pick the flags from the user.
    var viewConstraintBox = document.getElementById('view-constraint-box');
    viewConstraintBox.hidden = this._flagsAreIntrinsic;

    this.browser.addEventListener('load', this._onLoad, false);

    this._refresh();
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

    // Array of ids of displayed entries. This isn't used to specify which entries are
    // displayed but computed post-factum and used for determining if the view needs
    // to be refreshed.
    _entries: '',

    // Key elements.
    browser:      null,
    document:     null,
    feedContent:  null,


    // Query that selects entries contained by the view. It is the query to pull ALL the
    // entries, not only the ones displayed on the current page.
    __query: null,
    set query(aQuery) {
        this.__query = aQuery;
        return aQuery;
    },
    get query() {
        if (!this._flagsAreIntrinsic) {
            this.__query.unread = gPrefs.shownEntries == 'unread';
            this.__query.starred = gPrefs.shownEntries == 'starred';
            this.__query.deleted = gPrefs.shownEntries == 'trashed' ? ENTRY_STATE_TRASHED
                                                                    : ENTRY_STATE_NORMAL;
        }
        // XXX We should not have to reset the offset and limit every time.
        this.__query.limit = 0;
        this.__query.offset = 1;

        return this.__query;
    },


    pageCount:     0,
    entriesCount:  0,

    __currentPage: 1,
    set currentPage(aPageNumber) {
        if (aPageNumber != this.__currentPage && aPageNumber <= this.pageCount && aPageNumber > 0) {
            this.__currentPage = aPageNumber;
            this._refresh();
        }
    },
    get currentPage() {
        return this.__currentPage;
    },


    selectedEntry: null,

    // The ID is stored additionally, so we can preserve selection when refreshing.
    _selectedEntryID: '',

    // Used when going back one page by selecting previous entry
    // when the topmost entry is selected.
    _selectLastEntryOnRefresh: false,

    // Temporarily disable selecting entries.
    _selectionSuppressed: false,

    _autoScrollInterval: null,

    selectNextEntry: function FeedView_selectNextEntry() {
        if (this._selectionSuppressed)
            return;

        if (!this.selectedEntry) {
            this.selectEntry(this.feedContent.firstChild, true);
            return;
        }

        var nextEntry = this.selectedEntry.nextSibling;
        if (nextEntry)
            this.selectEntry(nextEntry, true);
        else
            this.currentPage++;
    },

    selectPrevEntry: function FeedView_selectPrevEntry() {
        if (this._selectionSuppressed)
            return;

        if (!this.selectedEntry) {
            this.selectEntry(this.feedContent.firstChild, true);
            return;
        }

        var prevEntry = this.selectedEntry.previousSibling;
        if (prevEntry) {
            this.selectEntry(prevEntry, true);
        }
        // Normally we wouldn't have to check |currentPage > 1|, because the setter
        // validates the input. However, we don't want to set _selectLastEntryOnRefresh
        // and then not refresh.
        else if (this.currentPage > 1) {
            this._selectLastEntryOnRefresh = true;
            this.currentPage--;
        }
    },

    /**
     *  Selects the given entry and smoothly scrolls it into view, if desired.
     *
     *  @param aEntry Entry to select (DOM element).
     *  @param aScroll Whether to scroll the entry into view (optional).
     *  @param aScrollInstantly Disable smooth scrolling (optional).
     */
    selectEntry: function FeedView_selectEntry(aEntry, aScroll, aScrollInstantly) {
        if (!this.isActive || aEntry == this.selectedEntry)
            return;

        if (this.selectedEntry)
            this.selectedEntry.removeAttribute('selected');

        if (!aEntry) {
            this.selectedEntry = null;
            this._selectedEntryID = '';
            return;
        }
        else {
            this.selectedEntry = aEntry;
            this._selectedEntryID = aEntry.id;
            aEntry.setAttribute('selected', true);
        }

        if (!gPrefs.keyNavEnabled)
            gPrefs.setBoolPref('feedview.keyNavEnabled', true);

        if (!aScroll)
            return;

        var win = this.document.defaultView;
        var targetScrollPos, distance, jump, difference;

        // If the entry is taller than the viewport height, align with the top.
        if (aEntry.offsetHeight >= win.innerHeight) {
            targetScrollPos = aEntry.offsetTop;
        }
        // Otherwise, scroll the entry to the middle of the screen.
        else {
            difference = win.innerHeight - aEntry.offsetHeight;
            targetScrollPos = aEntry.offsetTop - Math.floor(difference / 2);
        }

        if (targetScrollPos < 0)
            targetScrollPos = 0;
        else if (targetScrollPos > win.scrollMaxY)
            targetScrollPos = win.scrollMaxY;

        if (targetScrollPos == win.pageYOffset)
            return;

        if (aScrollInstantly) {
            win.scroll(win.pageXOffset, targetScrollPos);
            return;
        }

        distance = Math.floor(targetScrollPos - win.pageYOffset);
        jump = distance / 10;

        var self = this;
        function scroll() {
            // If we are within epsilon smaller than the jump, then scroll
            // directly to the target position.
            if (Math.abs(win.pageYOffset - targetScrollPos) < Math.abs(jump)) {
                win.scroll(win.pageXOffset, targetScrollPos)
                clearInterval(self._autoScrollInterval);
                self._selectionSuppressed = false;
                return;
            }
            win.scroll(win.pageXOffset, win.pageYOffset + jump);
        }

        // Clear the previous interval, if exists (might happen when we select
        // another entry before previous scrolling is finished).
        clearInterval(this._autoScrollInterval);

        // Disallow selecting futher entries until scrolling is finished.
        this._selectionSuppressed = true;

        // XXX Hack. The selection sometimes isn't unsuppressed in scroll()
        setTimeout(function() { self._selectionSuppressed = false }, 500);

        this._autoScrollInterval = setInterval(scroll, 7);
    },

    // Indicates whether the feed view is currently displayed in the browser.
    get isActive() {
        return (this.browser.currentURI.spec == gTemplateURI.spec);
    },

    get isGlobalSearch() {
        return !this.query.folders && !this.query.feeds && !this._flagsAreIntrinsic &&
               this.query.searchString;
    },

    get isViewSearch() {
        return (this.query.folders || this.query.feeds || this._flagsAreIntrinsic) &&
                gFeedView.query.searchString;
    },

    /**
     * Checks if the view is up-to-date (contains all the right entries nad has the
     * right title) and refreshes it if necessary.
     *
     * @returns TRUE if the view was up-to-date, FALSE if it needed refreshing.
     */
    ensure: function FeedView_ensure() {
        var isDirty = false;

        if (!this.isActive)
            return true;

        var prevEntries = this._entries;
        var currentEntriesCount = this.query.getEntriesCount();

        if (!prevEntries || !currentEntriesCount)
            this._refresh();

        // If a single entry was removed we do partial refresh, otherwise we
        // refresh from scratch.
        // Because in practice it is extremely unlikely for some entries to be removed
        // and others added with a single operation, the number of entries always changes
        // when the entry set changes. This greatly simplifies things, because we don't
        // have to check entries one by one and we can just compare their number.
        if (this.entriesCount - currentEntriesCount == 1) {
            var removedEntry = null;
            var removedEntryIndex;
            var currentEntries = this.query.getSerializedEntries().
                                            getPropertyAsAString('entries').
                                            match(/[^ ]+/g);

            // Find the removed entry.
            for (var i = 0; i < prevEntries.length; i++) {
                if (currentEntries.indexOf(prevEntries[i]) == -1) {
                    removedEntry = prevEntries[i];
                    removedEntryIndex = i;
                    break;
                }
            }

            // If there are no more entries on this page and it the last
            // page then perform full refresh.
            if (this.feedContent.childNodes.length == 1 && this.currentPage == this.pageCount) {
                this._refresh();
                return false;
            }

            // If the removed entry is on a different page than the
            // currently shown one then perform full refresh.
            var firstIndex = gPrefs.entriesPerPage * (this.currentPage - 1);
            var lastIndex = firstIndex + gPrefs.entriesPerPage;
            if (removedEntryIndex < firstIndex || removedEntryIndex > lastIndex) {
                this._refresh();
                return false;
            }

            this._refreshIncrementally(removedEntry);

            // Update this._entries here, so that this._refreshIncrementally()
            // doesn't have to call this.query.getSerializedEntries() again.
            this._entries = currentEntries;
            isDirty = true;
        }
        else if (this.entriesCount != currentEntriesCount) {
            this._refresh();
            return false;
        }

        // Update the title.
        var title = this.titleOverride || this.title;
        var titleElement = this.document.getElementById('feed-title');
        if (titleElement.textContent != title) {
            titleElement.textContent = title;
            isDirty = true;
        }

        return !isDirty;
    },


    // Refreshes the feed view from scratch.
    _refresh: function FeedView__refresh() {
        this.browser.style.cursor = 'wait';

        // Stop scrolling, so it doesn't continue after refreshing.
        clearInterval(this._autoScrollInterval);

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
        setTimeout(setEntries, 500);
    },


    // Refreshes the view when one entry is removed from the currently displayed page.
    _refreshIncrementally: function FeedView__refreshIncrementally(aEntryID) {
        var entry = this.document.getElementById(aEntryID);

        var entryWasSelected = (entry == this.selectedEntry);
        if (entryWasSelected) {
            // Immediately deselect the entry, so that no futher commands can be sent.
            this.selectEntry(null);

            // Remember the next and previous siblings as we
            // may need to select one of them.
            var nextSibling = entry.nextSibling;
            var previousSibling = entry.previousSibling;
        }

        // Remove the entry. We don't do it directly, because we want to
        // use jQuery to to fade it gracefully and we cannot call it from
        // here, because it's untrusted.
        var evt = document.createEvent('Events');
        evt.initEvent('RemoveEntry', false, false);
        entry.dispatchEvent(evt);

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
                self.selectEntry(nextSibling || appendedEntry || previousSibling || null, false);
        }

        // Don't append the new entry until the old one is removed.
        setTimeout(finish, 310);
    },


    // Computes the current entries count, page counter, current page ordinal and
    // refreshes the navigation UI.
    _computePages: function FeedView__computePages() {
        this.entriesCount = this.query.getEntriesCount();
        this.pageCount = Math.ceil(this.entriesCount / gPrefs.entriesPerPage);

        // This may happen for example when you are on the last page, and the
        // number of entries decreases (e.g. they are deleted).
        if (this.currentPage > this.pageCount)
            this.__currentPage = this.pageCount || 1;
        else if (this.currentPage == 0 && this.pageCount > 0)
            this.__currentPage = 1;

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


    // Listens to load events and builds the feed view page when necessary as
    // well as hides/unhides the feed view toolbar.
    _onLoad: function FeedView__onLoad(aEvent) {
        var feedViewToolbar = document.getElementById('feed-view-toolbar');
        gFeedView.browser.contentDocument.
                  addEventListener('mousedown', gFeedViewEvents.onFeedViewMousedown, true);

        if (gFeedView.isActive) {
            feedViewToolbar.hidden = false;
            gFeedView._buildFeedView();
            setTimeout(function(){ gFeedView._computePages() }, 0);
        }
        else {
            feedViewToolbar.hidden = true;
        }
    },


    // Generates and sets up the feed view page. Because we insert third-party
    // content in it (the entries are not served in plain text but in full HTML
    // markup) this page needs to be have a file:// URI to be unprivileged.
    // It is untrusted and all the interaction respects XPCNativeWrappers.
    _buildFeedView: function FeedView__buildFeedView() {
        var doc = this.document = this.browser.contentDocument;

        doc.defaultView.XMLHttpRequest = null;

        // Add listeners so that the content can communicate with chrome to perform
        // actions that require full privileges by sending custom events.
        doc.addEventListener('MarkEntryRead', gFeedViewEvents.onMarkEntryRead, true);
        doc.addEventListener('StarEntry', gFeedViewEvents.onStarEntry, true);
        doc.addEventListener('DeleteEntry', gFeedViewEvents.onDeleteEntry, true);
        doc.addEventListener('RestoreEntry', gFeedViewEvents.onRestoreEntry, true);

        // See comments next to the event handler functions.
        doc.addEventListener('click', gFeedViewEvents.onFeedViewClick, true);

        doc.defaultView.addEventListener('keypress', onKeyPress, true);

        // Apply the CSS.
        var style = doc.getElementsByTagName('style')[0];
        style.textContent = gFeedViewStyle;

        // Build the header...
        var titleElement = doc.getElementById('feed-title');
        titleElement.textContent = this.titleOverride || this.title;

        // When a single, unfiltered feed is viewed, construct the
        // feed's header: the subtitle, the image, and the link.
        var feed = gStorage.getFeed(this.query.feeds);
        if (feed && !this.searchString) {

            // Create the link.
            var header = doc.getElementById('header');
            header.setAttribute('href', feed.websiteURL ? feed.websiteURL : feed.feedURL);

            // Create feed image.
            if (feed.imageURL) {
                var feedImage = doc.getElementById('feed-image');
                feedImage.setAttribute('src', feed.imageURL);
                if (feed.imageTitle)
                    feedImage.setAttribute('title', feed.imageTitle);
            }

            // Create feed subtitle.
            if (feed.subtitle)
                doc.getElementById('feed-subtitle').innerHTML = feed.subtitle;
        }

        this.feedContent = doc.getElementById('feed-content');

        // If the trash folder is displayed this attribute is used for
        // setting visibility of buttons in article controls.
        if (this.query.deleted == ENTRY_STATE_TRASHED)
            this.feedContent.setAttribute('trash', true);

        // Show feed name in entry's subheader when displaying entries
        // from multiple feeds.
        if (!feed)
            this.feedContent.setAttribute('showFeedNames', true);

        // Pass values of the necessary preferences.
        if (gPrefs.showHeadlinesOnly)
            this.feedContent.setAttribute('showHeadlinesOnly', true);
        if (gPrefs.doubleClickMarks)
            this.feedContent.setAttribute('doubleClickMarks', true);

        // We have to hand the strings because stringbundles don't
        // work with unprivileged script.
        this.feedContent.setAttribute('markReadString', this.markAsReadStr);
        this.feedContent.setAttribute('markUnreadString', this.markAsUnreadStr);

        // Get the entries and append them.
        var query = this.query;
        query.offset = gPrefs.entriesPerPage * (this.currentPage - 1);
        query.limit = gPrefs.entriesPerPage;

        var entries = query.getEntries({});
        for (var i = 0; i < entries.length; i++)
            this._appendEntry(entries[i]);

        if (!entries.length)
            this._setEmptyViewMessage();

        // Select an entry if keyboard navigation is enabled.
        this._selectionSuppressed = false;
        if (gPrefs.keyNavEnabled) {

            var entry = doc.getElementById(this._selectedEntryID);
            if (this._selectedEntryID && entry) {
                this.selectEntry(entry, true, true);
            }
            else if (this._selectLastEntryOnRefresh) {
                entry = this.feedContent.lastChild;
                this.selectEntry(entry, true, true);
            }
            else {
                entry = this.feedContent.firstChild;
                this.selectEntry(entry, false);
            }

            this._selectLastEntryOnRefresh = false;
        }

        // Restore default cursor which we changed to
        // "wait" at the beginning of the refresh.
        this.browser.style.cursor = 'auto';
    },


    _appendEntry: function FeedView__appendEntry(aEntry) {
        var articleContainer = this.document.createElementNS(XHTML_NS, 'div');
        articleContainer.className = 'article-container';

        // Safely pass the data so that binding constructor can use it.
        articleContainer.setAttribute('id', aEntry.id);
        articleContainer.setAttribute('entryURL', aEntry.entryURL);
        articleContainer.setAttribute('entryTitle', aEntry.title);
        articleContainer.setAttribute('content', aEntry.content);

        if (gPrefs.showAuthors && aEntry.authors) {
            articleContainer.setAttribute('authors', this.authorPrefixStr + aEntry.authors);
        }
        if (aEntry.read)
            articleContainer.setAttribute('read', true);
        if (aEntry.starred)
            articleContainer.setAttribute('starred', true);

        if (aEntry.date) {
            var formatString = '';

            var entryDate = new Date(aEntry.date);
            var entryTime = entryDate.getTime() + 3600000;
            var nowTime = Date.now() + 3600000;

            var today = Math.ceil(nowTime / 86400000);
            var entryDay = Math.ceil(entryTime / 86400000);
            var deltaDays = today - entryDay;

            if (deltaDays === 0)
                formatString = this.todayStr + ', %X ';
            else if (deltaDays === 1)
                formatString += this.yesterdayStr + ', %X ';
            else if (deltaDays < 7)
                formatString += '%A, %X ';
            else
                formatString = '%d %B, %X ';

            var string = entryDate.toLocaleFormat(formatString);
            string = string.replace(/:\d\d /, ' ');
            // XXX We do it because %e conversion specification doesn't work
            string = string.replace(/^0/, '');

            articleContainer.setAttribute('date', string);

            if (aEntry.updated) {
                string += ' <span class="article-updated">' + this.updatedStr + '</span>'
                articleContainer.setAttribute('updated', string);
            }
        }

        var feedName = gStorage.getFeed(aEntry.feedID).title;
        articleContainer.setAttribute('feedName', feedName);

        if (gPrefs.showHeadlinesOnly)
            articleContainer.setAttribute('collapsed', true);

        this.feedContent.appendChild(articleContainer);

        return articleContainer;
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
    }

}


// Listeners for actions performed in the feed view.
var gFeedViewEvents = {

    onMarkEntryRead: function feedViewEvents_onMarkEntryRead( aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var readStatus = aEvent.target.hasAttribute('read');
        var query = new QuerySH(null, entryID, null);
        query.deleted = ENTRY_STATE_ANY;
        query.markEntriesRead(readStatus);
    },


    onDeleteEntry: function feedViewEvents_onDeleteEntry(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var query = new QuerySH(null, entryID, null);
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },


    onRestoreEntry: function feedViewEvents_onRestoreEntry(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var query = new QuerySH(null, entryID, null);
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_NORMAL);
    },


    onStarEntry: function feedViewEvents_onStarEntry( aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var newStatus = aEvent.target.hasAttribute('starred');
        var query = new QuerySH(null, entryID, null);
        query.starEntries(newStatus);
    },


    // This is for marking entry read when user follows the link. We can't do it
    // by dispatching custom events like we do above, because for whatever
    // reason the binding handlers don't catch middle-clicks.
    onFeedViewClick: function feedViewEvents_onFeedViewClick(aEvent) {
        var anonid = aEvent.originalTarget.getAttribute('anonid');
        var targetEntry = aEvent.target;

        if (gPrefs.keyNavEnabled && targetEntry.className == 'article-container')
            gFeedView.selectEntry(targetEntry, false);

        if (anonid == 'article-title-link' && (aEvent.button == 0 || aEvent.button == 1)) {
            aEvent.preventDefault();

            // Prevent default doesn't seem to stop the default action when
            // middle-clicking, so we've got stop propagation as well.
            if (aEvent.button == 1)
                aEvent.stopPropagation();

            var openEntriesInTabs = gPrefs.getBoolPref('feedview.openEntriesInTabs');
            var newTab = (aEvent.button == 0 && openEntriesInTabs || aEvent.button == 1);
            gCommands.openEntryLink(targetEntry, newTab);
        }
    },


    // By default document.popupNode doesn't dive into anonymous content
    // and returns the bound element; hence there's no context menu for
    // content of entries. To work around it, we listen for the mousedown
    // event and store the originalTarget, so it can be manually set as
    // document.popupNode (see gBrief.contextMenuOverride()
    // in brief-overlay.js).
    onFeedViewMousedown: function feedViewEvents_onFeedViewMousedown(aEvent) {
        if (aEvent.button == 2 && gFeedView.isActive)
            gTopBrowserWindow.gBrief.contextMenuTarget = aEvent.originalTarget;
        else
            gTopBrowserWindow.gBrief.contextMenuTarget = null;
    }

}
