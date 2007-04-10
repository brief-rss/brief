const THROBBER_URL = 'chrome://global/skin/throbber/Throbber-small.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';

var gFeedList = {

    tree:  null,
    items: null, // treecell elements of all the feeds

    _topLevelChildren: null, // the topmost <treechildren>

    /**
     * Currently selected item. Returns the treeitem if a folder is selected or
     * the treecell if a feed is selected.
     */
    get selectedItem() {
        var item = null;
        var currentIndex = this.tree.currentIndex;
        if (currentIndex != -1)
            item = this.tree.view.getItemAtIndex(currentIndex);
        return item;
    },

    get selectedFeed() {
        var feed = null;
        var feedId = this.selectedItem.getAttribute('feedId');
        if (feedId)
            feed = gStorage.getFeed(feedId);
        return feed;
    },

    getTreeitemForFeed: function(aFeedId) {
        var item = null;
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].getAttribute('feedId') == aFeedId) {
                item = this.items[i];
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
        if (!properties.match(aProperty))
            aItem.setAttribute('properties', properties + aProperty + ' ');
    },

    // Cf. with |setProperty|
    removeProperty: function(aItem, aProperty) {
        var properties = aItem.getAttribute('properties');
        if (properties.match(aProperty)) {
            properties = properties.replace(aProperty + ' ', '');
            aItem.setAttribute('properties', properties);
        }
    },

    // Cf. with |setProperty|
    hasProperty: function(aItem, aProperty) {
        var properties = aItem.getAttribute('properties');
        return properties.match(aProperty) ? true : false;
    },


    onselect: function(aEvent) {
        var selectedItem = gFeedList.selectedItem;
        if (!selectedItem || this.selectEventsSuppressed)
            return;

        if (selectedItem.hasAttribute('specialFolder')) {
            var rule = selectedItem.id == 'unread-folder' ? 'unread' :
                       selectedItem.id == 'starred-folder' ? 'starred' : 'trashed';
            var title = selectedItem.getAttribute('title');
            gFeedView = new FeedView(title, null, rule);
        }

        else if (selectedItem.hasAttribute('container')) {
            var title = selectedItem.getAttribute('label');
            var treeitems = selectedItem.getElementsByTagName('treeitem');
            var feedIds = '';
            for (var i = 0; i < treeitems.length; i++) {
                if (treeitems[i].hasAttribute('url'))
                    feedIds += treeitems[i].getAttribute('feedId') + ' ';
            }

            if (feedIds)
                gFeedView = new FeedView(title, feedIds);
        }

        else {
            var feedId = selectedItem.getAttribute('feedId');
            var title = gStorage.getFeed(feedId).title;
            if (feedId)
                gFeedView = new FeedView(title, feedId);
        }
    },


    createContextMenu: function(aEvent) {
        // Get the row which was the target of the right-click
        var rowIndex = {};
        this.tree.treeBoxObject.getCellAt(aEvent.clientX, aEvent.clientY, rowIndex, {}, {});
        // If the target was empty space, don't show any context menu.
        if (rowIndex.value == -1) {
            aEvent.preventDefault();
            return;
        }

        this.ctx_targetItem = this.tree.view.getItemAtIndex(rowIndex.value);

        // Set visibility of menuitems
        var markFeedRead = document.getElementById('ctx-mark-feed-read');
        markFeedRead.hidden = !this.ctx_targetItem.hasAttribute('url');

        var markFolderRead = document.getElementById('ctx-mark-folder-read');
        markFolderRead.hidden = this.ctx_targetItem.hasAttribute('url');

        var updateFeed = document.getElementById('ctx-update-feed');
        updateFeed.hidden = !this.ctx_targetItem.hasAttribute('url');

        var openWebsite = document.getElementById('ctx-open-website');
        openWebsite.hidden = !this.ctx_targetItem.hasAttribute('url');
        if (this.ctx_targetItem.hasAttribute('url')) {
            // Disable openWebsite if no websiteURL is available
            var feedId = this.ctx_targetItem.getAttribute('feedId');
            openWebsite.disabled = !gStorage.getFeed(feedId).websiteURL;
        }

        var separator = document.getElementById('ctx-separator');
        separator.hidden = this.ctx_targetItem.hasAttribute('specialFolder') &&
                           this.ctx_targetItem.id == 'starred-folder';

        var emptyFeed = document.getElementById('ctx-empty-feed');
        emptyFeed.hidden = !this.ctx_targetItem.hasAttribute('url');

        var emptyFolder = document.getElementById('ctx-empty-folder');
        emptyFolder.hidden = !(this.ctx_targetItem.hasAttribute('container') ||
                               this.ctx_targetItem.id == 'unread-folder');

        var restoreTrashed = document.getElementById('ctx-restore-trashed');
        restoreTrashed.hidden = this.ctx_targetItem.id != 'trash-folder';

        var emptyTrash = document.getElementById('ctx-empty-trash');
        emptyTrash.hidden = this.ctx_targetItem.id != 'trash-folder';
    },


    refreshSpecialTreeitem: function(aSpecialItem) {
        var treeitem = document.getElementById(aSpecialItem);
        var treecell = treeitem.firstChild.firstChild;

        var rule = aSpecialItem == 'unread-folder' ? 'unread' :
                   aSpecialItem == 'starred-folder' ? 'unread starred' :
                                                      'unread trashed' ;
        var unreadCount = gStorage.getEntriesCount(null, rule, null);

        var title = treeitem.getAttribute('title');
        if (unreadCount > 0) {
            var label = title + ' (' + unreadCount +')';
            this.setProperty(treecell, 'bold');
        }
        else {
            label = title;
            this.removeProperty(treecell, 'bold');
        }
        treecell.setAttribute('label', label);
    },


    /**
     * Make feed display up to date with database as far as read/unread
     * state and number of unread entries is concerned
     *
     * @param aFeedId   The feed whose item to update.
     * @param aTreeItem [Optional] DOM treeitem element of the feed; you can pass
     *                  it if you already have it when calling the function.
     */
    refreshFeedTreeitem: function(aFeedId, aTreeitem) {
        var treeitem = aTreeitem || this.getTreeitemForFeed(aFeedId);
        var treecell = treeitem.firstChild.firstChild;

        // Update the label
        var unreadCount = gStorage.getEntriesCount(aFeedId, 'unread', null);
        var title = treeitem.getAttribute('title');
        if (unreadCount > 0) {
            var label = title + ' (' + unreadCount +')';
            this.setProperty(treecell, 'bold');
        }
        else {
            label = title;
            this.removeProperty(treecell, 'bold');
        }
        treecell.setAttribute('label', label);


        // Update the favicon
        var iconURL;
        if (treeitem.hasAttribute('loading')) {
            iconURL = THROBBER_URL;
        }
        else if (treeitem.hasAttribute('error')) {
            iconURL = ERROR_ICON_URL;
        }
        else {
            var favicon = gStorage.getFeed(aFeedId).favicon;
            if (favicon != 'no-favicon' && gPrefs.getBoolPref('showFavicons'))
                iconURL = favicon;
        }

        if (iconURL)
            treecell.setAttribute('src', iconURL);
        // Just use the default icon applied by CSS
        else
            treecell.removeAttribute('src');
    },


    /**
     * Rebuilds the feed list tree.
     */
    rebuild: function() {
        this.tree = document.getElementById('feed-list');
        this._topLevelChildren = document.getElementById('top-level-children');

        this.refreshSpecialTreeitem('unread-folder');
        this.refreshSpecialTreeitem('starred-folder');
        this.refreshSpecialTreeitem('trash-folder');

        // Clear existing tree
        var lastChild = this._topLevelChildren.lastChild;
        while (lastChild.id == 'special-folders-separator') {
            this._topLevelChildren.removeChild(lastChild);
            lastChild = this._topLevelChildren.lastChild
        }

        this.feeds = gStorage.getFeedsAndFolders({});

        // This array stores all container nodes from the direct parent container of
        // the currently processed item up until the root.
        // We always append items to the last container in this array (i.e. the most
        // nested container). If a new container is encountered, it's pushed to the
        // array. After we're done reading container's children we pop it.
        this._levelParentNodes = [this._topLevelChildren];

        // Build the rest of the children recursively
        this._buildChildLivemarks('root');

        this.items = [];
        var items = this.tree.getElementsByTagName('treeitem');
        for (var i = 0; i < items.length; i++) {
            if (items[i].hasAttribute('url'))
                this.items.push(items[i]);
        }
    },


    /**
     * Recursively reads Live Bookmarks from a specified folder
     * and its subfolders and builds a tree.
     *
     * @param aParentFolder feedId of the folder.
     */
    _buildChildLivemarks: function(aParentFolder) {
        // Iterate over all the children.
        for (var i = 0; i < this.feeds.length; i++) {
            var feed = this.feeds[i];
            if (feed.isFolder && feed.parent == aParentFolder) {
                var prevParent = this._levelParentNodes[this._levelParentNodes.length - 1];
                var closedFolders = this.tree.getAttribute('closedFolders');
                var state = escape(closedFolders).match(escape(feed.feedId));

                var treeitem = document.createElement('treeitem');
                treeitem.setAttribute('container', 'true');
                treeitem.setAttribute('open', !state);
                treeitem.setAttribute('feedId', feed.feedId);
                treeitem.setAttribute('label', feed.title);
                treeitem = prevParent.appendChild(treeitem);

                var treechildren = document.createElement('treechildren');
                treechildren = treeitem.appendChild(treechildren);

                this._levelParentNodes.push(treechildren);

                this._buildChildLivemarks(feed.feedId);
            }
            else if (feed.parent == aParentFolder) {
                var parent = this._levelParentNodes[this._levelParentNodes.length - 1];

                var treeitem = document.createElement('treeitem');
                treeitem.setAttribute('feedId', feed.feedId);
                treeitem.setAttribute('url', feed.feedURL);
                treeitem.setAttribute('title', feed.title);
                treeitem = parent.appendChild(treeitem);

                var treerow = document.createElement('treerow');
                treerow = treeitem.appendChild(treerow);

                var treecell = document.createElement('treecell');
                treecell.setAttribute('properties', 'feed-item '); // Mind the whitespace
                treecell = treerow.appendChild(treecell);

                this.refreshFeedTreeitem(feed.feedId, treeitem);
            }
        }
        this._levelParentNodes.pop();
    }

}