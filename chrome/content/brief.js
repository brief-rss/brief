const EXT_ID = 'brief@mozdev.org';
const TEMPLATE_PATH = '/defaults/data/feedview-template.html';
const DEFAULT_STYLE_PATH = 'chrome://brief/skin/feedview.css'
const Cc = Components.classes;
const Ci = Components.interfaces;

var gFeedView;
var gStorage;
var gTemplateURL;
var gFeedViewStyle;

var brief = {

  briefLoaded: false,

  init: function(aEvent) {
    if (this.briefLoaded)
      return;
    this.briefLoaded = true;

    // Get the global services
    gStorage = Cc['@mozilla.org/brief/storage;1'].
               createInstance(Ci.nsIBriefStorage);
    gPrefs.register();
    gFeedViewStyle = this.getFeedViewStyle();

    // Get the extension's directory
    var extensionDir = Cc['@mozilla.org/extensions/manager;1'].
                       getService(Ci.nsIExtensionManager).
                       getInstallLocation(EXT_ID).
                       getItemLocation(EXT_ID).
                       path;
    // Replace backslashes with slashes.
    var regexp = new RegExp('%5C', 'g');
    extensionDir = escape(extensionDir).replace(regexp, '/');
    // Construct the final URL.
    gTemplateURL = 'file:///' + extensionDir + TEMPLATE_PATH;
    gTemplateURL = unescape(gTemplateURL);

    // Initiate the feed list.
    var liveBookmarksFolder = gPrefs.getCharPref('liveBookmarksFolder');
    if (liveBookmarksFolder) {
      gStorage.syncWithBookmarks();
      feedList.rebuild();
    }
    // If no Live Bookmarks folder has been picked yet, offer a button to do it
    else {
      var deck = document.getElementById('feed-list-deck');
      deck.selectedIndex = 1;
    }

    var viewConstraintList = document.getElementById('view-constraint-list');
    viewConstraintList.selectedIndex = gPrefs.shownEntries == 'all' ? 0 :
                                       gPrefs.shownEntries == 'unread' ? 1 : 2;

    var observerService = Cc["@mozilla.org/observer-service;1"].
                          getService(Ci.nsIObserverService);
    observerService.addObserver(this, 'brief:feed-updated', false);
    observerService.addObserver(this, 'brief:feed-loading', false);
    observerService.addObserver(this, 'brief:feed-error', false);
    observerService.addObserver(this, 'brief:entry-status-changed', false);
    observerService.addObserver(this, 'brief:sync-to-livemarks', false);
    observerService.addObserver(this, 'brief:batch-update-started', false);
  },


  unload: function() {
    var observerService = Cc["@mozilla.org/observer-service;1"].
                          getService(Ci.nsIObserverService);
    observerService.removeObserver(this, 'brief:feed-updated');
    observerService.removeObserver(this, 'brief:feed-loading');
    observerService.removeObserver(this, 'brief:feed-error');
    observerService.removeObserver(this, 'brief:sync-to-livemarks');
    observerService.removeObserver(this, 'brief:entry-status-changed');
    observerService.removeObserver(this, 'brief:batch-update-started');
    gPrefs.unregister();
  },


  // Storage and UpdateService components communicate with us through global
  // notifications.
  observe: function(aSubject, aTopic, aData) {
    switch (aTopic) {
      case 'brief:feed-updated':
        var feedId = aData;
        var item = feedList.getTreeitemForFeed(feedId);
        item.removeAttribute('error');
        item.removeAttribute('loading');
        feedList.refreshFeedTreeitem(feedId, item);
        this.finishedFeeds++;
        this.updateProgressMeter();

        if (aSubject.QueryInterface(Ci.nsIVariant) > 0) {
          feedList.refreshSpecialTreeitem('unread-folder');

          // If the the updated feed is currently being displayed,
          // refresh the feed view.
          if (gFeedView && gFeedView.feedViewActive &&
              ( (!gFeedView.feedId && gFeedView.rules == 'unread') ||
                (gFeedView.feedId && gFeedView.feedId.match(feedId))  ))
            gFeedView.refresh();
        }
        break;

      case 'brief:feed-loading':
        var item = feedList.getTreeitemForFeed(aData);
        item.setAttribute('loading', true);
        feedList.refreshFeedTreeitem(aData, item);
        break;

      case 'brief:feed-error':
        var feedId = aData;
        var item = feedList.getTreeitemForFeed(feedId);
        feedList.removeProperty(item, 'loading');
        item.setAttribute('error', true);
        feedList.refreshFeedTreeitem(feedId, item);
        this.finishedFeeds++;
        this.updateProgressMeter();
        break;

      case 'brief:sync-to-livemarks':
        feedList.rebuild();
        var deck = document.getElementById('feed-list-deck');
        deck.selectedIndex = 0;
        break;

      case 'brief:batch-update-started':
        var progressmeter = document.getElementById('update-progress');
        progressmeter.hidden = false;
        progressmeter.value = 0;
        this.totalFeeds = gStorage.getAllFeeds({}).length;
        this.finishedFeeds = 0;
        break;

      case 'brief:entry-status-changed':
        aSubject.QueryInterface(Ci.nsIWritablePropertyBag2);
        var changedFeeds = aSubject.getPropertyAsAUTF8String('feedIdList');
        var changedEntries = aSubject.getPropertyAsAUTF8String('entryIdList');

        // We break down the list of feeds which changed entries belong
        // to and update their treeitems.
        var changedFeedsArray = changedFeeds.match(/[^ ]+/g);
        var changedEntriesArray = changedEntries.match(/[^ ]+/g);

        switch (aData) {
          case 'unread':
          case 'read':
            // If view is set to show only unread entries, we need to refresh it
            // if any of the shown entries have been marked read.
            if (gFeedView && gFeedView.feedViewActive &&
                gFeedView.rules == 'unread') {
              var viewedEntriesList = escape(gFeedView.entryIdList);
              for (var i = 0; i < changedEntriesArray.length; i++) {
                var changedEntry = escape(changedEntriesArray[i]);
                if (viewedEntriesList.match(changedEntry)) {
                  gFeedView.refresh();
                  break;
                }
              }
            }
            // Otherwise, we just visually mark the changed entries as read.
            else if (gFeedView && gFeedView.feedViewActive) {
              var nodes = gFeedView.feedContentDiv.childNodes;
              var changedEntries = escape(changedEntries);
              for (var i = 0; i < nodes.length; i++) {
                var entryId = escape(nodes[i].getAttribute('id'));
                if (changedEntries.match(entryId)) {
                  if (aData == 'read')
                    nodes[i].setAttribute('read', 'true');
                  else
                    nodes[i].removeAttribute('read');
                }
              }
            }

            for (var i = 0; i < changedFeedsArray.length; i++)
              feedList.refreshFeedTreeitem(changedFeedsArray[i])

            // We can't know if any of those need updating, so we have to
            // update them all.
            feedList.refreshSpecialTreeitem('unread-folder');
            feedList.refreshSpecialTreeitem('starred-folder');
            feedList.refreshSpecialTreeitem('trash-folder');
            break;

          case 'starred':
            if (gFeedView && gFeedView.feedViewActive &&
                gFeedView.rules == 'starred') {
              var viewedEntriesList = escape(gFeedView.entryIdList);
              for (var i = 0; i < changedEntriesArray.length; i++) {
                var changedEntry = escape(changedEntriesArray[i]);
                if (viewedEntriesList.match(changedEntry)) {
                  gFeedView.refresh();
                  break;
                }
              }
            }
            feedList.refreshSpecialTreeitem('starred-folder');
            break;

          case 'deleted':
            if (gFeedView && gFeedView.feedViewActive) {
              var viewedEntriesList = escape(gFeedView.entryIdList);
              for (var i = 0; i < changedEntriesArray.length; i++) {
                var changedEntry = escape(changedEntriesArray[i]);
                 if (viewedEntriesList.match(changedEntry)) {
                  gFeedView.refresh();
                  break;
                }
              }
            }

            var changedFeedsArray = changedFeeds.match(/[^ ]+/, 'g');
            for (var i = 0; i < changedFeedsArray.length; i++)
              feedList.refreshFeedTreeitem(changedFeedsArray[i])

            feedList.refreshSpecialTreeitem('unread-folder');
            feedList.refreshSpecialTreeitem('starred-folder');
            feedList.refreshSpecialTreeitem('trash-folder');
            break;
        }
    }
  },


  // Returns a string containing the style of the feed view.
  getFeedViewStyle: function() {
    if (gPrefs.getBoolPref('useCustomStyle')) {
      var pref = gPrefs.getComplexValue('customStylePath', Ci.nsISupportsString);
      var url = 'file:///' + pref.data;
    }
    else
      var url = DEFAULT_STYLE_PATH;

    var request = new XMLHttpRequest;
    request.open('GET', url, false);
    request.send(null);

    return request.responseText;
  },


  updateProgressMeter: function() {
    var progressmeter = document.getElementById('update-progress');
    var percentage = 100 * this.finishedFeeds / this.totalFeeds;
    progressmeter.value = percentage;

    if (percentage == 100)
      progressmeter.hidden = true;
  },


// Listeners for actions performed in the feed view.

  onMarkEntryRead: function(aEvent) {
    var entryID = aEvent.target.getAttribute('id');
    var readStatus = aEvent.target.hasAttribute('read') ? true : false;
    gStorage.markEntriesRead(readStatus, entryID, null, null);
  },

  onDeleteEntry: function(aEvent) {
    var entryID = aEvent.target.getAttribute('id');
    gStorage.deleteEntries(entryID, 1);
  },

  onRestoreEntry: function(aEvent) {
    var entryID = aEvent.target.getAttribute('id');
    gStorage.deleteEntries(entryID, 0);
  },

  onStarEntry: function(aEvent) {
    var entryID = aEvent.target.getAttribute('id');
    var isStarred = aEvent.target.hasAttribute('starred');
    var newStatus = isStarred ? false : true;
    gStorage.starEntry(entryID, newStatus);
  },

  onFeedViewClick: function(aEvent) {
    var target = aEvent.originalTarget.getAttribute('anonid');
    var entry = aEvent.target;
    if (target == 'article-title-link' && !entry.hasAttribute('read') &&
        (aEvent.button == 0 || aEvent.button == 1)) {
      if (gPrefs.getBoolPref('linkMarksRead')) {
        entry.setAttribute('read', true);
        var id = entry.getAttribute('id');
        gStorage.markEntriesRead(true, id, null, null);
      }
    }
  },


// Toolbar commands.

  updateAllFeeds: function() {
    var updateService = Cc['@mozilla.org/brief/updateservice;1'].
                        createInstance(Ci.nsIBriefUpdateService);
    updateService.fetchAllFeeds();
  },

  openOptions: function(aPaneID) {
    var features = 'chrome,titlebar,toolbar,centerscreen,modal,resizable';
    window.openDialog('chrome://brief/content/options/options.xul', null,
                      features, aPaneID);
  },

  showNextPage: function() {
    gFeedView.currentPage++;
    gFeedView.refresh();
  },

  showPrevPage: function() {
    gFeedView.currentPage--;
    gFeedView.refresh();
  },

  onConstraintListCmd: function(aEvent) {
    var choice = aEvent.target.id;
    var prefValue = choice == 'show-all' ? 'all' :
                    choice == 'show-unread' ? 'unread' : 'starred';

    gPrefs.setCharPref('shownEntries', prefValue);
    gFeedView.refresh();
  },


  markCurrentViewRead: function(aNewStatus) {
    // Optimization not to call markEntriesRead when there's nothing to mark.
    // We check the number of entries that need to be marked.
    var oldStatus = aNewStatus ? 'unread' : 'read';
    var rules = gFeedView.rules + ' ' + oldStatus;
    var entriesToMarkCount = gStorage.getEntriesCount(gFeedView.feedId, rules,
                                                      gFeedView.searchTerms);
    if (entriesToMarkCount)
      gStorage.markEntriesRead(aNewStatus, null, gFeedView.feedId,
                               gFeedView.rules);
  },


  performSearch: function(aEvent) {
    var searchbar = document.getElementById('searchbar');

    // For a global search we create a new FeedView, so let's do it if we didn't
    // yet.
    if (searchbar.searchScope == 1 &&
        (!gFeedView || !gFeedView.isGlobalSearchView)) {

      // We need to suppress selection so that feedList.onselect() doesn't fire.
      // nsITreeSelection.selectEventsSuppressed doesn't seem to work here, so
      // we have to set our own flag which we will check in onselect().
      var selection = feedList.tree.view.selection;
      feedList.selectEventsSuppressed = true;
      selection.clearSelection();
      feedList.selectEventsSuppressed = false;

      gFeedView = new FeedView(null, null, searchbar.value);
      gFeedView.isGlobalSearchView = true;
    }
    else if (gFeedView) {
      gFeedView.searchString = searchbar.value;
      gFeedView.refresh();
    }
  },


// Feed list context menu commands.

  ctx_markFeedRead: function(aEvent) {
    var item = feedList.ctx_targetItem;
    var feedId = feedList.ctx_targetItem.getAttribute('feedId');
    gStorage.markEntriesRead(true, null, feedId, null);
  },

  ctx_markFolderRead: function(aEvent) {
    var item = feedList.ctx_targetItem;

    if (item.hasAttribute('specialView')) {
      var rule = item.id == 'unread-folder' ? 'unread' :
                 item.id == 'starred-folder' ? 'starred' : 'trashed';
      gStorage.markEntriesRead(true, null, null, rule);
    }
    else {
      var feedItems = item.getElementsByTagName('treecell');
      var feedIds = '';
      for (var i = 0; i < feedItems.length; i++)
        feedIds += feedItems[i].getAttribute('feedId') + ' ';
      gStorage.markEntriesRead(true, null, feedIds, null);
    }
  },

  ctx_updateFeed: function(aEvent) {
    var feedId = feedList.ctx_targetItem.getAttribute('feedId');
    var updateService = Cc['@mozilla.org/brief/updateservice;1'].
                        createInstance(Ci.nsIBriefUpdateService);
    updateService.fetchFeed(feedId);
  },

  ctx_openWebsite: function(aEvent) {
    var feedId = feedList.ctx_targetItem.getAttribute('feedId');
    var url = gStorage.getFeed(feedId).websiteURL;
    var mainWindow = window.QueryInterface(Ci.nsIInterfaceRequestor).
                            getInterface(Ci.nsIWebNavigation).
                            QueryInterface(Ci.nsIDocShellTreeItem).
                            rootTreeItem.
                            QueryInterface(Ci.nsIInterfaceRequestor).
                            getInterface(Ci.nsIDOMWindow);
    mainWindow.gBrowser.loadOneTab(url);
  },

  ctx_emptyTrash: function(aEvent) {
    var trashedEntries = gStorage.
                         getSerializedEntries(null, null, 'trashed', null).
                         getPropertyAsAUTF8String('entryIdList');
    if (trashedEntries)
      gStorage.deleteEntries(trashedEntries, 2);
  }

}


var gPrefs = {

  register: function() {
    this._branch = Cc['@mozilla.org/preferences-service;1'].
                   getService(Ci.nsIPrefService).
                   getBranch('extensions.brief.').
		   QueryInterface(Ci.nsIPrefBranch2);

    this.getIntPref = this._branch.getIntPref;
    this.getBoolPref = this._branch.getBoolPref;
    this.getCharPref = this._branch.getCharPref;
    this.getComplexValue = this._branch.getComplexValue;

    this.setIntPref = this._branch.setIntPref;
    this.setBoolPref = this._branch.setBoolPref;
    this.setCharPref = this._branch.setCharPref;

    // Cache the frequently accessed prefs
    this.entriesPerPage = this.getIntPref('entriesPerPage');
    this.shownEntries = this.getCharPref('shownEntries');

    this._branch.addObserver('', this, false);
  },


  unregister: function() {
    this._branch.removeObserver('', this);
  },


  observe: function(aSubject, aTopic, aData) {
    if (aTopic != 'nsPref:changed')
      return;
    switch (aData) {
      case 'showFavicons':
        var feeds = gStorage.getAllFeeds({});
        for (var i = 0; i < feeds.length; i++)
          feedList.refreshFeedTreeitem(feeds[i].feedId);
        break;

      case 'customStylePath':
        if (this.getBoolPref('useCustomStyle'))
          gFeedViewStyle = brief.getFeedViewStyle();
        break;


      case 'useCustomStyle':
        gFeedViewStyle = brief.getFeedViewStyle();
        break;

      // Observers to keep the cached prefs up to date
      case 'entriesPerPage':
        this.entriesPerPage = this.getIntPref('entriesPerPage');
        break;

      case 'shownEntries':
       this.shownEntries = this.getCharPref('shownEntries');
       break;
    }
  }

}

function dump(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n ' + aMessage);
}
