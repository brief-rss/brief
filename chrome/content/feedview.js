const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

/**
 * This object represents the main feed display. It stores and manages
 * the the display parameters.
 * 
 * @param aFeedURL Space-separated list of URLs identifying the feeds whose 
 *                 entries to display. 
 * @param aRules   Rules which shown entries must match. If no rules are 
 *                 specified, the one stored in shownEntries preference is used.  
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
  
  //brief.feedViewStyle = brief.getFeedViewStyle();
  
  // If view was created with a specific set of rules (e.g. special "Unread"
  // view), prevent user from choosing the rule himself.
  var viewConstraintBox = document.getElementById('view-constraint-box');
  viewConstraintBox.hidden = this.baseRules ? true : false;
  
  this.browser.addEventListener('load', this.onLoad, false);
  
  // If the feed wasn't updated yet, do it now.
  var feed = gStorage.getFeed(this.feedId);
  if (feed && !feed.everUpdated)
    gUpdateService.fetchFeed(this.feedId);
 
  this.refresh();
}


FeedView.prototype = {
  
  feedId:          '',
  baseRules:       '',
  
  searchString:    '',
  entryIdList:     '',
  currentPage:     0,
  pageCount:       0,
  entriesCount:    0,
  unreadCount:     0,
  
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
  
  get rules() {
    return this.baseRules ? this.baseRules : gPrefs.shownEntries;
  },
  
  refresh: function() {
    this.browser.style.cursor = 'wait';
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
    this.pageDesc.value = gStringbundle.getFormattedString('pageNumberDescription',
                                            [this.currentPage, this.pageCount]);

    this.browser.loadURI(gTemplateURL);
  },
  
  
  // Listens to load events and builds the feed view page when necessary as
  // well as hides/unhides the feed view toolbar
  onLoad: function(aEvent) {
    var feedViewToolbar = document.getElementById('feed-view-toolbar');
    if (gFeedView.feedViewActive) {
      feedViewToolbar.hidden = false;
      gFeedView.buildFeedView();
    }
    else
      feedViewToolbar.hidden = true;
  },
  
  
  // Generates and sets up the feed view page.   
  buildFeedView: function() {
    var doc = this.document = this.browser.contentDocument;
    
    doc.defaultView.XMLHttpRequest = null;

    // Add listeners so that the content can communicate with chrome to perform
    // actions that require full privileges.
    doc.addEventListener('MarkEntryRead', brief.onMarkEntryRead, true);
    doc.addEventListener('StarEntry', brief.onStarEntry, true);
    doc.addEventListener('DeleteEntry', brief.onDeleteEntry, true);
    doc.addEventListener('RestoreEntry', brief.onRestoreEntry, true);
    
    // This is for marking entry read when user follows the link. We can't do it
    // by dispatching custom events as we do above, because for whatever reason
    // the binding handlers don't catch middle-clicks.
    doc.addEventListener('click', brief.onFeedViewClick, true);
    
    // Apply the CSS.
    var style = doc.getElementsByTagName('style')[0];
    style.textContent = brief.feedViewStyle;
    
    // Build the feed header if needed, that is, if the view contains a
    // single feed. 
    var feed = this.specialView ? null : gStorage.getFeed(this.feedId);
    if (feed) {
      // Create the link.
      var headerLink = doc.getElementById('header');
      headerLink.setAttribute('href', feed.websiteURL ? feed.websiteURL 
                                                      : feed.feedURL);      
      // Create feed title.
      if (feed.title) {
        var title = doc.getElementById('feed-title');
        title.textContent = feed.title;
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
    // Otherwise hide the header.
    else
      doc.getElementById('header').style.display = 'none';
      
    // If the trash folder is displayed, set an attribute based on which we
    // adjust the available items in the entry controls popup.
    if (!this.feedId && this.rules == 'trashed')
      doc.getElementById('feed-content').setAttribute('trash', true);
    
    // Get the entries
    var offset = gPrefs.entriesPerPage * (this.currentPage - 1);
    var entries = gStorage.getEntries(null, this.feedId, this.rules, 
                                      this.searchString, offset, 
                                      gPrefs.entriesPerPage, {});

    this.feedContentDiv = doc.getElementById('feed-content');
    
    // We have to hand the strings because stringbundles don't seem to work
    // with unprivileged code.
    var markReadString = gStringbundle.getString('markEntryAsRead');
    this.feedContentDiv.setAttribute('markReadString', markReadString);
    var markEntryAsUnread = gStringbundle.getString('markEntryAsUnread');
    this.feedContentDiv.setAttribute('markUnreadString', markEntryAsUnread);
    var starEntry = gStringbundle.getString('starEntry');
    this.feedContentDiv.setAttribute('starString', starEntry);
    var unstarEntry = gStringbundle.getString('unstarEntry');
    this.feedContentDiv.setAttribute('unstarString', unstarEntry);
    
    for each (entry in entries) {
      var articleContainer = doc.createElementNS(XHTML_NS, 'div');
      articleContainer.className = 'article-container';
      
      // Safely pass the data so that binding constructor can use it.
      articleContainer.setAttribute('id', entry.id);
      articleContainer.setAttribute('entryURL', entry.entryURL);
      articleContainer.setAttribute('title', entry.title);
      articleContainer.setAttribute('summary', entry.summary);
      articleContainer.setAttribute('content', entry.content);
      articleContainer.setAttribute('date', entry.date);
      if (entry.read)
        articleContainer.setAttribute('read', true);
      if (entry.starred)
        articleContainer.setAttribute('starred', true);
              
      // This is for when we're displaying entries from multiple feeds.
      articleContainer.setAttribute('feedId', entry.feedId);
      var feedTitle = gStorage.getFeed(entry.feedId).title;
      articleContainer.setAttribute('feedTitle', feedTitle);
      
      this.feedContentDiv.appendChild(articleContainer);
    }
   
    this.entryIdList = gStorage.
                       getSerializedEntries(null, this.feedId, this.rules, null).
                       getPropertyAsAUTF8String('entryIdList');
    // Restore default cursor which we changed to "wait" at the beginning of
    // the refresh.
    this.browser.style.cursor = 'auto';
  }

};
