const NC_NAME          = 'http://home.netscape.com/NC-rdf#Name';
const NC_FEEDURL       = 'http://home.netscape.com/NC-rdf#FeedURL';
const NC_LIVEMARK      = 'http://home.netscape.com/NC-rdf#Livemark';
const NC_DESCRIPTION   = 'http://home.netscape.com/NC-rdf#Description';

const RDF_NEXT_VAL     = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nextVal';
const RDF_INSTANCE_OF  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#instanceOf';
const RDF_SEQ_INSTANCE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#Seq';
const RDF_SEQ          = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#_';
const RDF_TYPE         = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const THROBBER_URL = 'chrome://global/skin/throbber/Throbber-small.gif';

var feedList = {
  
  initiated: false,
  tree: null,
  topLevelChildren: null,
  items: null, // treecell elements of all the feeds in the list 
  
  init: function() {
    this.tree = document.getElementById('feed-list');
    this.topLevelChildren = document.getElementById('top-level-children');
    
    var unreadFolder = document.getElementById('unread-folder');
    unreadFolder.setAttribute('title', unreadFolder.getAttribute('label'));
    feedList.refreshSpecialTreeitem('unread-folder');
    
    var starredFolder = document.getElementById('starred-folder');
    starredFolder.setAttribute('title', starredFolder.getAttribute('label'));
    feedList.refreshSpecialTreeitem('starred-folder');
    
    var trashFolder = document.getElementById('trash-folder');
    trashFolder.setAttribute('title', trashFolder.getAttribute('label'));
    feedList.refreshSpecialTreeitem('trash-folder'); 
    
    // Initialize tree builder
    this.rdfs = Cc['@mozilla.org/rdf/rdf-service;1'].getService(Ci.nsIRDFService);
    this.bmds = this.rdfs.GetDataSource('rdf:bookmarks');
  
    // Predicates
    this.nextValArc = this.rdfs.GetResource(RDF_NEXT_VAL);
    this.instanceOfArc = this.rdfs.GetResource(RDF_INSTANCE_OF);
    this.typeArc = this.rdfs.GetResource(RDF_TYPE);
    this.nameArc = this.rdfs.GetResource(NC_NAME);
    this.feedUrlArc = this.rdfs.GetResource(NC_FEEDURL);
  
    // Common resources
    this.sequence = this.rdfs.GetResource(RDF_SEQ_INSTANCE);
    this.livemarkType = this.rdfs.GetResource(NC_LIVEMARK);
    
    this.initiated = true;
  },
  
  
  /**
   * Currently selected item. Returns the treeitem if a folder is selected or 
   * the treecell if a feed is selected.
   */           
  get selectedItem() {
    var item = null;
    var currentIndex = this.tree.currentIndex;
    
    if (currentIndex != -1) {
      item = this.tree.view.getItemAtIndex(currentIndex);
      if (!item.getAttribute('container') && !item.hasAttribute('separator'))
        item = item.firstChild.firstChild;
    }
       
    return item;
  },
  
  
  get selectedFeed() {
    var feedId = this.selectedItem.getAttribute('feedId');
    var feed = gStorage.getFeed(feedId);
    return feed;
  },
  
  
  getTreeitemForFeed: function(aFeedId) {
    var item = null;
    for (var i = 0; i < this.feedItems.length; i++) {
      if (this.feedItems[i].getAttribute('feedId') == aFeedId) {
        item = this.feedItems[i];
        break;
      }
    }
    return item;
  },

  
  /**
   * Sets a property on a content tree item.
   * 
   * Trees cannot be styled using normal DOM attributes, "properties" attribute
   * whose value contains space-separated pseudo-attributes has to be used 
   * instead. This is a convenience function to make setting a property work 
   * the same and be as easy as setting an attribute.
   * 
   * @param aItem     Subject tree element
   * @param aProperty Property to be set
   */
  setProperty: function(aItem, aProperty) {
    var properties = aItem.getAttribute('properties');
    if (!properties.match(aProperty)) {
      aItem.setAttribute('properties', properties + aProperty + ' ');
    }
  },
  
  
  /**
   * See |setProperty|
   */
  removeProperty: function(aItem, aProperty) {
    var properties = aItem.getAttribute('properties');
    if (properties.match(aProperty)) {
      properties = properties.replace(aProperty + ' ', '');
      aItem.setAttribute('properties', properties);
    }
  },
  
  
  /**
   * See |setProperty|
   */     
  hasProperty: function(aItem, aProperty) {
    var properties = aItem.getAttribute('properties');
    if (properties.match(aProperty))
      return true;
    else
      return false;
  },
  
  
  onselect: function(aEvent) {
    var item = feedList.selectedItem;
    if (!item || this.selectEventsSuppressed)
      return;
    
    if (item.hasAttribute('specialView')) {
      var rule = item.id == 'unread-folder' ? 'unread' :
                 item.id == 'starred-folder' ? 'starred' : 'trashed';
      gFeedView = new FeedView(null, rule);
    }
    
    else if (item.hasAttribute('container')) {
      var feedItems = item.getElementsByTagName('treecell');
      var feedIds = '';
      for (var i = 0; i < feedItems.length; i++)
        feedIds += feedItems[i].getAttribute('feedId') + ' '; 
      if (feedIds)
        gFeedView = new FeedView(feedIds);
    }
    
    else {
      var feedId = feedList.selectedItem.getAttribute('feedId');
      if (feedId)
        gFeedView = new FeedView(feedId);
    }
  },
    
  
  createContextMenu: function(aEvent) {
    // Get the row which was the target of the right-click
    var rowIndex = {};
    this.tree.treeBoxObject.
              getCellAt(aEvent.clientX, aEvent.clientY, rowIndex, {}, {});
    var row = this.tree.view.getItemAtIndex(rowIndex.value);
    
    this.ctx_targetItem = row.getAttribute('container') ? 
                          row : row.firstChild.firstChild;
     
    // Set visibility of menuitems
    var markFeedRead = document.getElementById('ctx-mark-feed-read');
    markFeedRead.hidden = !this.ctx_targetItem.hasAttribute('feedId');
    
    var markFolderRead = document.getElementById('ctx-mark-folder-read');
    markFolderRead.hidden = this.ctx_targetItem.hasAttribute('feedId');
    
    var updateFeed = document.getElementById('ctx-update-feed');
    updateFeed.hidden = !this.ctx_targetItem.hasAttribute('feedId');
    
    var openWebsite = document.getElementById('ctx-open-website');
    openWebsite.hidden = !this.ctx_targetItem.hasAttribute('feedId');
    if (this.ctx_targetItem.hasAttribute('feedId')) {
      // Disable openWebsite if no websiteURL is available
      var feedId = this.ctx_targetItem.getAttribute('feedId');
      openWebsite.disabled = !gStorage.getFeed(feedId).websiteURL;
    }
      
    var emptyTrash = document.getElementById('ctx-empty-trash');
    emptyTrash.hidden = this.ctx_targetItem.id != 'trash-folder';
  },
    
  
  refreshSpecialTreeitem: function(aSpecialItem) {
    var item = document.getElementById(aSpecialItem);
    
    var rule = aSpecialItem == 'unread-folder' ? 'unread' :
              aSpecialItem == 'starred-folder' ? 'unread starred' : 
                                                 'unread trashed' ;  
    var unreadCount = gStorage.getEntriesCount(null, rule, null);

    var title = item.getAttribute('title');
    if (unreadCount > 0) {
      var label = title + ' (' + unreadCount +')';
      this.setProperty(item, 'bold');
    }
    else {
      label = title;
      this.removeProperty(item, 'bold');
    }
    item.setAttribute('label', label);
  },
  
  
  /**
   * Make feed display up to date with database as far as read/unread
   * state and number of unread entries is concerned
   * 
   * @param aFeedId   The feed whose item to update.
   * @param aTreeItem DOM treeitem element of the feed. Optional, you can pass 
   *                  it if you already have it when calling the function.
   */
  refreshFeedTreeitem: function(aFeedId, aTreeitem) {  
    var item = aTreeitem ? aTreeitem : this.getTreeitemForFeed(aFeedId);
    
    // Update the label
    var unreadCount = gStorage.getEntriesCount(aFeedId, 'unread', null);
    var title = item.getAttribute('title');
    if (unreadCount > 0) {
      var label = title + ' (' + unreadCount +')';
      this.setProperty(item, 'bold');
    }
    else {
      label = title;
      this.removeProperty(item, 'bold');
    }
    item.setAttribute('label', label);
    
    // Update the favicon
    if (item.hasAttribute('loading'))
      item.setAttribute('src', THROBBER_URL);
    else if (item.hasAttribute('error'))
      item.setAttribute('src', ERROR_ICON_URL);
    else {
      var favicon = gStorage.getFeed(aFeedId).favicon;
      if (favicon && favicon != 'no-favicon' 
          && gPrefs.getBoolPref('showFavicons'))
        item.setAttribute('src', favicon);
      // Just use the default icon applied by CSS
      else
        item.removeAttribute('src');
    }
  },
  
  
  /**
   * Rebuilds the feed list tree.
   */
  rebuild: function() {
    if (!this.initiated)
      this.init();
    
    this.refreshSpecialTreeitem('unread-folder');
    this.refreshSpecialTreeitem('starred-folder');
    this.refreshSpecialTreeitem('trash-folder');
    
    var rootID = gPrefs.getCharPref('liveBookmarksFolder');
    this.rootFolder = this.rdfs.GetResource(rootID);
    
    // Clear existing tree
    while (this.topLevelChildren.lastChild) {
      var lastChild = this.topLevelChildren.lastChild;
      if (lastChild.id == 'special-folders-separator')
        break;
      this.topLevelChildren.removeChild(lastChild);
    }
    
    // This array stores all container nodes from the direct parent container of
    // the currently processed item up until the root. 
    // We always append items to the last container in this array (i.e. the most
    // nested container). If a new container is encountered, it's pushed to the 
    // array. After we're done reading container's children we pop it.
    this.levelParentNodes = new Array();
    this.levelParentNodes.push(this.topLevelChildren);
    
    // Build the rest of the children recursively
    this.buildChildLivemarks(this.rootFolder);
    
    this.feedItems = new Array();
    var items = this.tree.getElementsByTagName('treecell');
    for (var i = 0; i < items.length; i++) {
      if (items[i].hasAttribute('url'))
        this.feedItems.push(items[i]);
    }
  },
  
  
  /**
   * Recursively reads Live Bookmarks from a specified folder 
   * and its subfolders and builds a tree.
   * 
   * @param aParentFolder RDF resource id of the folder.
   */
  buildChildLivemarks: function(aParentFolder) {
    // Get the number of container's children
    var nextVal = this.bmds.GetTarget(aParentFolder, this.nextValArc, true);
    var length = nextVal.QueryInterface(Ci.nsIRDFLiteral).Value - 1;
    
    // Iterate over all the children
    for (var i = 1; i <= length; i++) {
      var seqArc = this.rdfs.GetResource(RDF_SEQ + i);
      var child = this.bmds.GetTarget(aParentFolder, seqArc, true);
      
      // XXX Workaround to a situation when nexVal value is incorrect after
      // sorting or removing bookmarks. Don't know why this happens.
      if (!child)
        continue;
      
      // If the child is a livemark, add to the tree
      var type = this.bmds.GetTarget(child, this.typeArc, true);
      if (type == this.livemarkType) {
        var feedURL = this.bmds.GetTarget(child, this.feedUrlArc, true).
                                QueryInterface(Ci.nsIRDFLiteral).
                                Value;
        var feedId = hashString(feedURL);
        var title = this.bmds.GetTarget(child, this.nameArc, true).
                              QueryInterface(Ci.nsIRDFLiteral).
                              Value;
        
        var parent = this.levelParentNodes[this.levelParentNodes.length - 1];
        
        var treeitem = document.createElement('treeitem');
        treeitem = parent.appendChild(treeitem);
        
        var treerow = document.createElement('treerow');
        treerow = treeitem.appendChild(treerow);
        
        var treecell = document.createElement('treecell');
        treecell.setAttribute('label', title);
        treecell.setAttribute('feedId', feedId);
        treecell.setAttribute('url', feedURL);
        treecell.setAttribute('title', title);
        // Mind the whitespace
        treecell.setAttribute('properties', 'feed-item ');
        treecell = treerow.appendChild(treecell);
        
        this.refreshFeedTreeitem(feedId, treecell);
      }
      else {
        // If the child is a container, add it to the tree and recursively
        // read its children 
        var instance = this.bmds.GetTarget(child, this.instanceOfArc, true);
        if (instance == this.sequence) {
          var title = this.bmds.GetTarget(child, this.nameArc, true).
                                QueryInterface(Ci.nsIRDFLiteral).
                                Value;
          
          var prevParent = this.levelParentNodes[this.levelParentNodes.length - 1];
          
          var treeitem = document.createElement('treeitem');
          treeitem.setAttribute('container', 'true');
          treeitem.setAttribute('open', 'true');
          treeitem.setAttribute('label', title);
          treeitem = prevParent.appendChild(treeitem);
          
          var treechildren = document.createElement('treechildren');
          treechildren = treeitem.appendChild(treechildren);

          this.levelParentNodes.push(treechildren);
          
          this.buildChildLivemarks(child);
        }
      }
    }
    this.levelParentNodes.pop();
  }

};

  // XXX Copied from nsBriefStorage, a better solution avoiding code duplication
  // is needed.
  function hashString(aString) {
    var hasher = Cc['@mozilla.org/security/hash;1'].
                 createInstance(Ci.nsICryptoHash);
    
    // nsICryptoHash can read the data either from an array or a stream.
    // Creating a stream ought to be faster than converting a long string 
    // into an array using JS.
    var stringStream = Cc["@mozilla.org/io/string-input-stream;1"].
                       createInstance(Ci.nsIStringInputStream);
    stringStream.setData(aString, aString.length);
    
    hasher.init(Ci.nsICryptoHash.MD5);
    hasher.updateFromStream(stringStream, stringStream.available());
    var hash = hasher.finish(false);
    
    // Convert the hash to a hex-encoded string.
    var hexchars = '0123456789ABCDEF';
    var hexrep = new Array(hash.length * 2);
    for (var i = 0; i < hash.length; ++i) {
      hexrep[i * 2] = hexchars.charAt((hash.charCodeAt(i) >> 4) & 15);
      hexrep[i * 2 + 1] = hexchars.charAt(hash.charCodeAt(i) & 15);
    }
    return hexrep.join('');
  }
