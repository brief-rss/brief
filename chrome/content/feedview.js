const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

/**
 * This object represents the main feed display. It stores and manages
 * the display parameters.
 *
 * @param aFeedURL      Space-separated list of URLs identifying the feeds whose
 *                      entries to display.
 * @param aRules        Rules to which this view is tied to, overriding rules
 *                      specified in shownEntries preference is used.
 * @param aSearchString Strings which the displayed entries must contain.
 */
function FeedView(aFeedId, aRules, aSearchString) {
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
    this.pageDesc = document.getElementById('page-desc');
    this.prevPageButton = document.getElementById('prev-page');
    this.nextPageButton = document.getElementById('next-page');

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

    this.refresh();
}


FeedView.prototype = {

    // Below are parameters determining which entries are displayed.
    feedId:          '', // Space-separated list of feed ids.
    baseRules:       '', // Rules to which the view is tied to.
    searchString:    '', // Only display entries containing this string.

    // Space-separated list of ids of displayed entries. This isn't used to
    // specify which entries are displayed but computed post-factum and used
    // for determining if refresh is needed when the database changes.
    _entries:        '',

    currentPage:     0,
    pageCount:       0,
    entriesCount:    0,

    // Cached frequently used elements.
    browser:         null,
    document:        null,
    prevPageButton:  null,
    nextPageButton:  null,
    pageDesc:        null,
    feedContentDiv:  null,

    // Indicates whether the feed view is currently displayed in the browser.
    get feedViewActive() {
        return (unescape(this.browser.currentURI.spec) == gTemplateURL);
    },

    // Actual rules used by the view.
    get rules() {
        return this.baseRules ? this.baseRules : gPrefs.shownEntries;
    },


    // Refreshes the feed view from scratch.
    refresh: function() {
        this.browser.style.cursor = 'wait';

        this._computePages();

        // Load the template. The actual content building happens when the template
        // page is loaded - see _onLoad below.
        this.browser.loadURI(gTemplateURL);

        // Store a list of ids of displayed entries. It is used to determine if
        // the view needs to be refreshed when database changes.
        this._entries = gStorage.
                        getSerializedEntries(null, this.feedId, this.rules, null).
                        getPropertyAsAUTF8String('entryIdList');
    },


    refreshWhenEntriesRemoved: function(aEntries) {
        for (var i = 0; i < aEntries.length; i++) {
            if (this._entries.match(aEntries[i])) {
                if (aEntries.length == 1)
                    gFeedView._refreshIncrementally(aEntries[0]);
                else
                    gFeedView.refresh();
                break;
            }
        }
    },


    _refreshIncrementally: function(aEntryId) {
        // Find the entry that has to be removed and remove it.
        var entry = this.feedContentDiv.firstChild;
        while (entry.getAttribute('id') != aEntryId)
            entry = entry.nextSibling;
        this.feedContentDiv.removeChild(entry);

        // If there are no more entries on this page and it the last one, we have to
        // perform full refresh.
        if (!this.feedContentDiv.childNodes.length && this.currentPage == this.pageCount) {
            this.refresh();
            return;
        }

        this._computePages();
        var offset = gPrefs.entriesPerPage * this.currentPage;
        var entry = gStorage.getEntries(null, this.feedId, this.rules, this.searchString,
                                        offset, 1, {})[0];
        if (entry)
            this._appendEntry(entry);


        this._entries = gStorage.
                        getSerializedEntries(null, this.feedId, this.rules, null).
                        getPropertyAsAUTF8String('entryIdList');
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
        this.prevPageButton.setAttribute('disabled', this.currentPage <= 1);
        this.nextPageButton.setAttribute('disabled', this.currentPage == this.pageCount);
        var stringbundle = document.getElementById('main-bundle');
        this.pageDesc.value = stringbundle.getFormattedString('pageNumberDescription',
                                                [this.currentPage, this.pageCount]);
    },


    // Listens to load events and builds the feed view page when necessary as
    // well as hides/unhides the feed view toolbar.
    _onLoad: function(aEvent) {
        var feedViewToolbar = document.getElementById('feed-view-toolbar');
        if (gFeedView.feedViewActive) {
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

        // Build the feed header if the view contains a single feed, otherwise hide
        // it.
        var feed = this.specialView ? null : gStorage.getFeed(this.feedId);
        if (feed) {
            // Create the link.
            var header = doc.getElementById('header');
            header.setAttribute('href', feed.websiteURL ? feed.websiteURL
                                                        : feed.feedURL);
            // Create feed title.
            if (feed.title) {
                var title = doc.getElementById('feed-title');
                var text = doc.createTextNode(feed.title);
                title.appendChild(text);
            }

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
        else
            doc.getElementById('header').style.display = 'none';

        this.feedContentDiv = doc.getElementById('feed-content');

        // If the trash folder is displayed, set an attribute based on which we
        // adjust the available items in the entry controls popup.
        if (!this.feedId && this.rules == 'trashed')
            this.feedContentDiv.setAttribute('trash', true);

        // Pass the value of the pref.
        if (gPrefs.doubleClickMarks)
            this.feedContentDiv.setAttribute('doubleClickMarks', true);

        // We have to hand the strings because stringbundles don't work with
        // unprivileged script.
        var stringbundle = document.getElementById('main-bundle');
        var markReadString = stringbundle.getString('markEntryAsRead');
        this.feedContentDiv.setAttribute('markReadString', markReadString);
        var markEntryAsUnread = stringbundle.getString('markEntryAsUnread');
        this.feedContentDiv.setAttribute('markUnreadString', markEntryAsUnread);
        var starEntry = stringbundle.getString('starEntry');
        this.feedContentDiv.setAttribute('starString', starEntry);
        var unstarEntry = stringbundle.getString('unstarEntry');
        this.feedContentDiv.setAttribute('unstarString', unstarEntry);

        // Get the entries
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
        var doc = this.document;

        var articleContainer = doc.createElementNS(XHTML_NS, 'div');
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

        // This is for when we're displaying entries from multiple feeds.
        articleContainer.setAttribute('feedId', aEntry.feedId);
        var feedTitle = gStorage.getFeed(aEntry.feedId).title;
        articleContainer.setAttribute('feedTitle', feedTitle);

        this.feedContentDiv.appendChild(articleContainer);
    }

}
