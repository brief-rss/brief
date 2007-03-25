const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

/**
 * This object represents the main feed display. It stores and manages
 * the display parameters.
 *
 * @param aTitle        Title of the view which will be shown in the header
 * @param aFeedURL      Space-separated list of URLs identifying the feeds whose
 *                      entries to display.
 * @param aRules        Rules to which this view is tied to, overriding rules
 *                      specified in shownEntries preference is used.
 * @param aSearchString String which the displayed entries must contain.
  */
function FeedView(aTitle, aFeedId, aRules, aSearchString) {
    this.title = aTitle;
    this.feedId = aFeedId;
    this.baseRules = aRules;
    this.searchString = aSearchString;

    // Clear the searchbar
    if (!aSearchString) {
        var searchbar = document.getElementById('searchbar');
        searchbar.setAttribute('showingDescription', true);
    }

    // Cache various elements for later use
    this.browser = document.getElementById('feed-view');
    this.document = this.browser.contentDocument;

    // If view is tied to specified baseRules (e.g. special "Unread" view), hide
    // the UI to pick the rules from the user.
    var viewConstraintBox = document.getElementById('view-constraint-box');
    viewConstraintBox.hidden = this.baseRules ? true : false;

    this.browser.addEventListener('load', this._onLoad, false);

    // If the feed wasn't updated yet, do it now.
    var feed = gStorage.getFeed(this.feedId);
    if (feed && !feed.everUpdated) {
        var updateService = Cc['@mozilla.org/brief/updateservice;1'].
                            createInstance(Ci.nsIBriefUpdateService);
        updateService.fetchFeed(this.feedId);
    }

    this._refresh();
}


FeedView.prototype = {

    title: '',

    // Below are parameters determining which entries are displayed.
    feedId:          '', // Space-separated list of feed ids.
    baseRules:       '', // Rules to which the view is tied to.
    searchString:    '', // Only display entries containing this string.

    // Array of ids of displayed entries. This isn't used to specify which entries are
    // displayed but computed post-factum and used for determining if the view needs
    // to be refreshed when the database changes.
    _entries:        '',

    currentPage:   0,
    pageCount:     0,
    entriesCount:  0,

    // Key elements.
    browser:      null,
    document:     null,
    feedContent:  null,

    // Indicates whether the feed view is currently displayed in the browser.
    get active() {
        return (this.browser.currentURI.spec == gTemplateURI.spec);
    },

    // Actual rules used by the view.
    get rules() {
        return this.baseRules ? this.baseRules : gPrefs.shownEntries;
    },

    ensure: function() {
        if (!this.active)
            return true;

        // Get arrays of previously viewed entries and the ones that should be viewed now.
        var prevEntries = this._entries;
        var currentEntries =
                   gStorage.
                   getSerializedEntries(null, this.feedId, this.rules, this.searchString).
                   getPropertyAsAUTF8String('entryIdList').
                   match(/[^ ]+/g);

        // We need to perform a full refresh if any entries were added or when more than
        // one entry was removed. Because currently there can be no situation when some
        // entries are added and some removed at the same time, comparing the number of
        // entries is enough to check for those cases.
        if (prevEntries && currentEntries && prevEntries.length == currentEntries.length)
            return true;

        if (!prevEntries || !currentEntries || prevEntries.length < currentEntries.length ||
           prevEntries.length - currentEntries.length > 1) {
            this._refresh();
            return false;
        }

        // Now we now that only one entry was changed and that it was removed. Find out
        // which one.
        var removedEntry = '';
        for (i = 0; i < prevEntries.length; i++) {
            if (currentEntries.indexOf(prevEntries[i]) == -1) {
                var removedEntry = prevEntries[i];
                break;
            }
        }

        // If there are no more entries on this page and it the last page, perform full refresh.
        if (removedEntry && this.feedContent.childNodes.length == 1 &&
           this.currentPage == this.pageCount) {
            this._refresh();
            return false;
        }

        // If the removed entry is on a different page than the currently shown one,
        // preform full refresh.
        var firstIndex = gPrefs.entriesPerPage * (this.currentPage - 1);
        var lastIndex = firstIndex + gPrefs.entriesPerPage;
        if (prevEntries.indexOf(removedEntry) < firstIndex ||
           prevEntries.indexOf(removedEntry) > lastIndex) {
            this._refresh();
            return false;
        }

        if (removedEntry) {
            this._refreshIncrementally(removedEntry);
            return false;
        }

        return true;
    },


    // Refreshes the feed view from scratch.
    _refresh: function() {
        this.browser.style.cursor = 'wait';

        this._computePages();

        // Load the template. The actual content building happens when the template
        // page is loaded - see _onLoad below.
        this.browser.loadURI(gTemplateURI.spec);

        // Store a list of ids of displayed entries. It is used to determine if
        // the view needs to be refreshed when database changes.
        this._entries =
                   gStorage.
                   getSerializedEntries(null, this.feedId, this.rules, this.searchString).
                   getPropertyAsAUTF8String('entryIdList').
                   match(/[^ ]+/g);
    },


    _refreshIncrementally: function(aEntryId) {
        // Find the entry that has to be removed and remove it.
        var entry = this.feedContent.firstChild;
        while (entry.id != aEntryId)
            entry = entry.nextSibling;
        var evt = document.createEvent('Events');
        evt.initEvent('RemoveEntry', false, false);
        entry.dispatchEvent(evt);

        this._computePages();
        var offset = gPrefs.entriesPerPage * this.currentPage - 1;
        var entry = gStorage.getEntries(null, this.feedId, this.rules, this.searchString,
                                        offset, 1, {})[0];
        if (entry)
            this._appendEntry(entry);

        this._entries =
                   gStorage.
                   getSerializedEntries(null, this.feedId, this.rules, this.searchString).
                   getPropertyAsAUTF8String('entryIdList').
                   match(/[^ ]+/g);
    },


    _computePages: function() {
        this.entriesCount = gStorage.getEntriesCount(this.feedId, this.rules,
                                                     this.searchString);
        this.pageCount = Math.ceil(this.entriesCount / gPrefs.entriesPerPage);

        // This may happen for example when you are on the last page, and the
        // number of entries decreases (e.g. they are deleted)
        if (this.currentPage > this.pageCount)
            this.currentPage = this.pageCount;
        else if (this.currentPage == 0 && this.pageCount > 0)
            this.currentPage = 1;

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
    _onLoad: function(aEvent) {
        var feedViewToolbar = document.getElementById('feed-view-toolbar');
        if (gFeedView.active) {
            feedViewToolbar.hidden = false;
            gFeedView._buildFeedView();
        }
        else
          feedViewToolbar.hidden = true;
    },


    // Generates and sets up the feed view page. Because we insert third-party
    // content in it (the entries are not served in plain text but in full HTML
    // markup) this page needs to be have a file:// URI to be unprivileged.
    // It is untrusted and all the interaction respects XPCNativeWrappers.
    _buildFeedView: function() {
        var doc = this.document = this.browser.contentDocument;

        // All file:// URIs are treated as same-origin which allows a script
        // running in a page to access local files via XHR. Because of it Firefox is
        // vulnerable to numerous attack vectors  (primarily when browsing locally
        // saved websites) and so are we, because we insert untrusted content into
        // the local template page. Same-origin policy is going to be tightened in
        // Firefox 3 (hopefully earlier) which will fix the problem.
        // Null-ing out XMLHttpRequest object is making the exploit harder but there
        // are ways around it.
        doc.defaultView.XMLHttpRequest = null;

        // Add listeners so that the content can communicate with chrome to perform
        // actions that require full privileges by sending custom events.
        doc.addEventListener('MarkEntryRead', brief.onMarkEntryRead, true);
        doc.addEventListener('StarEntry', brief.onStarEntry, true);
        doc.addEventListener('DeleteEntry', brief.onDeleteEntry, true);
        doc.addEventListener('RestoreEntry', brief.onRestoreEntry, true);

        // This is for marking entry read when user follows the link. We can't do it
        // by dispatching custom events like we do above, because for whatever
        // reason the binding handlers don't catch middle-clicks.
        doc.addEventListener('click', brief.onFeedViewClick, true);

        // Apply the CSS.
        var style = doc.getElementsByTagName('style')[0];
        style.textContent = gFeedViewStyle;

        // Build the header.
        var titleElement = doc.getElementById('feed-title');
        var textNode = doc.createTextNode(this.title);
        titleElement.appendChild(textNode);

        // When a single, unfiltered feed is viewed, construct the feed's header.
        var feed = gStorage.getFeed(this.feedId);
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
                doc.getElementById('feed-subtitle').textContent = feed.subtitle;
        }

        this.feedContent = doc.getElementById('feed-content');

        // If the trash folder is displayed this attribute adjusts the visibility of the
        // button in article controls.
        if (this.rules == 'trashed')
            this.feedContent.setAttribute('trash', true);

        if (!feed)
            this.feedContent.setAttribute('showFeedNames', true);

        // Pass the value of the pref.
        if (gPrefs.doubleClickMarks)
            this.feedContent.setAttribute('doubleClickMarks', true);

        // We have to hand the strings because stringbundles don't work with
        // unprivileged script.
        var stringbundle = document.getElementById('main-bundle');
        var markReadString = stringbundle.getString('markEntryAsRead');
        this.feedContent.setAttribute('markReadString', markReadString);
        var markEntryAsUnread = stringbundle.getString('markEntryAsUnread');
        this.feedContent.setAttribute('markUnreadString', markEntryAsUnread);

        // Get the entries data and append them.
        var offset = gPrefs.entriesPerPage * (this.currentPage - 1);
        var entries = gStorage.getEntries(null, this.feedId, this.rules,
                                          this.searchString, offset,
                                          gPrefs.entriesPerPage, {});
        for (var i = 0; i < entries.length; i++)
            this._appendEntry(entries[i]);

        // Restore default cursor which we changed to "wait" at the beginning of
        // the refresh.
        this.browser.style.cursor = 'auto';
    },


    _appendEntry: function(aEntry) {
        var articleContainer = this.document.createElementNS(XHTML_NS, 'div');
        articleContainer.className = 'article-container';

        // Safely pass the data so that binding constructor can use it.
        articleContainer.setAttribute('id', aEntry.id);
        articleContainer.setAttribute('entryURL', aEntry.entryURL);
        articleContainer.setAttribute('title', aEntry.title);
        articleContainer.setAttribute('summary', aEntry.summary);
        articleContainer.setAttribute('content', aEntry.content);
        articleContainer.setAttribute('date', aEntry.date);
        if (aEntry.read)
            articleContainer.setAttribute('read', true);
        if (aEntry.starred)
            articleContainer.setAttribute('starred', true);

        var feedName = gStorage.getFeed(aEntry.feedId).title;
        articleContainer.setAttribute('feedName', feedName);

        this.feedContent.appendChild(articleContainer);
    },


    showNextPage: function() {
        gFeedView.currentPage++;
        gFeedView._refresh();
    },

    showPrevPage: function() {
        gFeedView.currentPage--;
        gFeedView._refresh();
    }

}
