const THROBBER_URL = 'chrome://global/skin/throbber/Throbber-small.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';

var gFeedList = {

    tree:  null,
    items: null, // treecell elements of all the feeds

    selectEventsSuppressed: false,

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

    getTreeitem: function(aFeedId) {
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
        if (!properties.match(aProperty + ' '))
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


    getFoldersForFeeds: function(aFeedIds) {
        var folders = [];
        for (var i = 0; i < aFeedIds.length; i++) {
            var parent = gStorage.getFeed(aFeedIds[i]).parent;
            while (parent != 'root') {
                if (folders.indexOf(parent) == -1)
                    folders.push(parent);
                parent = gStorage.getFeed(parent).parent;
            }
        }
        return folders;
    },


    onselect: function(aEvent) {
        var selectedItem = gFeedList.selectedItem;

        if (!selectedItem || this.selectEventsSuppressed ||
           this._prevSelectedItem == selectedItem) {
            return;
        }
        // Clicking the twisty also triggers the select event, although the selection
        // doesn't change. We remember the previous selected item and do nothing when
        // the new selected item is the same.
        this._prevSelectedItem = selectedItem;

        if (selectedItem.hasAttribute('specialFolder')) {
            var title = selectedItem.getAttribute('title');
            var query = new Query();

            query.unread = selectedItem.id == 'unread-folder';
            query.starred = selectedItem.id == 'starred-folder';
            query.deleted = selectedItem.id == 'trash-folder' ? ENTRY_STATE_TRASHED
                                                              : ENTRY_STATE_NORMAL;
            gFeedView = new FeedView(title, query);
        }

        else if (selectedItem.hasAttribute('container')) {
            var title = this.selectedFeed.title;
            var folder = selectedItem.getAttribute('feedId');
            var query = new Query();
            query.folders = folder;
            gFeedView = new FeedView(title, query);
        }

        else {
            var feedId = selectedItem.getAttribute('feedId');
            var title = gStorage.getFeed(feedId).title;
            var query = new QuerySH(feedId, null, null);
            if (feedId)
                gFeedView = new FeedView(title, query);
        }
    },

    onClick: function(aEvent) {
        var rowIndex = {};
        this.tree.treeBoxObject.getCellAt(aEvent.clientX, aEvent.clientY, rowIndex, {}, {});
        if (rowIndex.value != -1) {
            var item = this.tree.view.getItemAtIndex(rowIndex.value);
            if (item.hasAttribute('container'))
                this.refreshFolderTreeitems(item);
        }
    },

    onKeyUp: function(aEvent) {
        if (aEvent.keyCode == aEvent.DOM_VK_RETURN) {
            var selectedItem = this.selectedItem;
            if (selectedItem.hasAttribute('container'))
                this.refreshFolderTreeitems(selectedItem);
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

        var query = new QuerySH(null, null, true);
        if (aSpecialItem == 'starred-folder')
            query.starred = true;
        else if (aSpecialItem == 'trash-folder')
            query.deleted = ENTRY_STATE_TRASHED;
        var unreadCount = gStorage.getEntriesCount(query);

        var title = treeitem.getAttribute('title');
        if (unreadCount > 0) {
            var label = title + ' (' + unreadCount +')';
            this.setProperty(treecell, 'unread');
        }
        else {
            label = title;
            this.removeProperty(treecell, 'unread');
        }
        treecell.setAttribute('label', label);
    },

    /**
     * Refresh the folder's label.
     *
     * @param aFeeds  nsIBriefFeed object, feedId string, treeitem XUL element, or an
     *                array of either of them.
     */
    refreshFolderTreeitems: function(aFolders) {
        var treeitem, treecell, folder, query, unreadCount, label;
        var folders = aFolders instanceof Array ? aFolders : [aFolders];

        for (var i = 0; i < folders.length; i++) {

            if (typeof folders[i] == 'string') {
                folder = gStorage.getFeed(folders[i]);
                treeitem = this.getTreeitem(folder.feedId);
            }
            else if (folders[i] instanceof Ci.nsIBriefFeed) {
                folder = folders[i];
                treeitem = this.getTreeitem(folder.feedId);
            }
            else if (folders[i] instanceof XULElement) {
                folder = gStorage.getFeed(folders[i].getAttribute('feedId'));
                treeitem = folders[i];
            }
            else {
                throw('Invalid argument type, must be nsIBriefFeed, XULElement or string');
            }
            treecell = treeitem.firstChild.firstChild;

            if (treeitem.getAttribute('open') == 'true') {
                label = folder.title;
                this.removeProperty(treecell, 'unread');
            }
            else {
                query = new Query();
                query.folders = folder.feedId;
                query.unread = true;
                unreadCount = gStorage.getEntriesCount(query);

                if (unreadCount > 0) {
                    label = folder.title + ' (' + unreadCount +')';
                    this.setProperty(treecell, 'unread');
                }
                else {
                    label = folder.title;
                    this.removeProperty(treecell, 'unread');
                }
            }
            treecell.setAttribute('label', label);
        }
    },

    /**
     * Refresh the feed treeitem's label and favicon.
     *
     * @param aFeeds  nsIBriefFeed object, feedId string, treeitem XUL element, or an
     *                array of either of them.
     */
    refreshFeedTreeitems: function(aFeeds) {
        var feed, treeitem, treecell, query, unreadCount, label, iconURL, favicon;
        var feeds = aFeeds instanceof Array ? aFeeds : [aFeeds];

        for (var i = 0; i < feeds.length; i++) {

            if (typeof feeds[i] == 'string') {
                feed = gStorage.getFeed(feeds[i]);
                treeitem = this.getTreeitem(feed.feedId);
            }
            else if (feeds[i] instanceof Ci.nsIBriefFeed) {
                feed = feeds[i];
                treeitem = this.getTreeitem(feed.feedId);
            }
            else if (feeds[i] instanceof XULElement) {
                feed = gStorage.getFeed(feeds[i].getAttribute('feedId'));
                treeitem = feeds[i];
            }
            else {
                throw('Invalid argument type, must be nsIBriefFeed, XULElement or string');
            }
            treecell = treeitem.firstChild.firstChild;

            // Update the label.
            query = new QuerySH(feed.feedId, null, true);
            unreadCount = gStorage.getEntriesCount(query);
            if (unreadCount > 0) {
                label = feed.title + ' (' + unreadCount +')';
                this.setProperty(treecell, 'unread');
            }
            else {
                label = feed.title;
                this.removeProperty(treecell, 'unread');
            }
            treecell.setAttribute('label', label);


            // Update the favicon
            if (treeitem.hasAttribute('loading')) {
                iconURL = THROBBER_URL;
            }
            else if (treeitem.hasAttribute('error')) {
                iconURL = ERROR_ICON_URL;
            }
            else {
                favicon = feed.favicon;
                if (favicon != 'no-favicon' && gPrefs.getBoolPref('showFavicons'))
                    iconURL = favicon;
            }

            if (iconURL)
                treecell.setAttribute('src', iconURL);
            // Otherwise just use the default icon applied by CSS
            else
                treecell.removeAttribute('src');
        }
        // Don't refresh the parent folders if we are called during building the tree.
        // 1) The item list is not ready 2) _buildChildLivemarks refreshes each item
        // anyway.
        if (this.items) {
            var folders = this.getFoldersForFeeds(aFeeds);
            this.refreshFolderTreeitems(folders);
        }
    },


    /**
     * Rebuilds the feed list tree.
     */
    rebuild: function() {
        this.tree = document.getElementById('feed-list');
        var topLevelChildren = document.getElementById('top-level-children');

        this.refreshSpecialTreeitem('unread-folder');
        this.refreshSpecialTreeitem('starred-folder');
        this.refreshSpecialTreeitem('trash-folder');

        // Clear existing tree
        var lastChild = topLevelChildren.lastChild;
        while (lastChild.id != 'special-folders-separator') {
            topLevelChildren.removeChild(lastChild);
            lastChild = topLevelChildren.lastChild
        }

        this.feeds = gStorage.getFeedsAndFolders({});

        // This array stores all container nodes from the direct parent container of
        // the currently processed item up until the root.
        // We always append items to the last container in this array (i.e. the most
        // nested container). If a new container is encountered, it's pushed to the
        // array. After we're done reading container's children we pop it.
        this._levelParentNodes = [topLevelChildren];

        // Build the rest of the children recursively
        this._buildChildLivemarks('root');

        this.items = this.tree.getElementsByTagName('treeitem');
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
                var state = closedFolders.match(feed.feedId) ? true : false;

                var treeitem = document.createElement('treeitem');
                treeitem.setAttribute('container', 'true');
                treeitem.setAttribute('open', !state);
                treeitem.setAttribute('feedId', feed.feedId);
                treeitem = prevParent.appendChild(treeitem);

                var treerow = document.createElement('treerow');
                treerow = treeitem.appendChild(treerow);

                var treecell = document.createElement('treecell');
                treecell = treerow.appendChild(treecell);

                this.refreshFolderTreeitems(treeitem);

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
                treeitem = parent.appendChild(treeitem);

                var treerow = document.createElement('treerow');
                treerow = treeitem.appendChild(treerow);

                var treecell = document.createElement('treecell');
                treecell.setAttribute('properties', 'feed-item '); // Mind the whitespace
                treecell = treerow.appendChild(treecell);

                this.refreshFeedTreeitems(treeitem);
            }
        }
        this._levelParentNodes.pop();
    }

}