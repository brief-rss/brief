const THROBBER_URL = 'chrome://global/skin/throbber/Throbber-small.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';

var gFeedList = {

    tree:  null,
    items: null,  // All treeitems in the tree.
    ctx_targetItem: null,  // Current target item of the context menu.
    _prevSelectedItem: null,

    // If TRUE, prevents the onSelect function from running when
    // "select" event is occurs.
    ignoreSelectEvent: false,

    // Currently selected item. Returns the treeitem if a folder is selected or
    // the treecell if a feed is selected.
    get selectedItem() {
        var item = null;
        var currentIndex = this.tree.currentIndex;
        if (currentIndex != -1)
            item = this.tree.view.getItemAtIndex(currentIndex);
        return item;
    },

    // nsIBriefFeed object of the the currently selected feed, or null.
    get selectedFeed() {
        var feed = null;
        var feedID = this.selectedItem.getAttribute('feedID');
        if (feedID)
            feed = gStorage.getFeed(feedID);
        return feed;
    },

    /**
     * Gets nsIBriefFeed representation of a given feed. We've got feeds floating around
     * represented in at least 3 different ways: nsIBriefFeed's, ID's of feeds, and
     * treeitems). This function allows us to ensure that the argument is of nsIBriefFeed
     * type, whenever we need it. It also makes it easy for other methods of gFeedList to
     * accept any arguments of any type.
     *
     * @param  aFeed  nsIBriefFeed object, feedID string, or treeitem XULElement.
     */
    getBriefFeed: function gFeedList_getBriefFeed(aFeed) {
        if (aFeed instanceof Ci.nsIBriefFeed)
            return aFeed;

        var feedID;
        if (typeof aFeed == 'string')
            feedID = aFeed;
        else if (aFeed instanceof XULElement)
            feedID = aFeed.getAttribute('feedID');

        return gStorage.getFeed(feedID);
    },

    /**
     * Cf. |getBriefFeed|.
     *
     * @param  aFeed  nsIBriefFeed object, feedID string, or treeitem XULElement.
     */
    getTreeitem: function gFeedList_getTreeitem(aFeed) {
        if (aFeed instanceof XULElement)
            return aFeed;

        var feedID;
        if (aFeed instanceof Ci.nsIBriefFeed)
            feedID = aFeed.feedID;
        else if (typeof aFeed == 'string')
            feedID = aFeed;

        var item = null;
        for (var i = 0; i < this.items.length; i++) {
            if (this.items[i].getAttribute('feedID') == feedID) {
                item = this.items[i];
                break;
            }
        }
        return item;
    },

    /**
     * Returns an array of feedID's of all folders in the the parent chain of any of the
     * given feeds.
     *
     * @param   aFeeds  A feed or an array of them, represented by
     *                  nsIBriefFeed object, feedID string, or treeitem XULElement.
     * @returns Array of feedID's of folders.
     */
    getFoldersForFeeds: function gFeedList_getFoldersForFeeds(aFeeds) {
        var feeds = aFeeds instanceof Array ? aFeeds : [aFeeds];
        var folders = [];

        var rootURI = gPrefs.getCharPref('liveBookmarksFolder');
        var rootFolderID = hashString(rootURI);

        for (var i = 0; i < feeds.length; i++) {
            var feed = this.getBriefFeed(feeds[i]);
            var parentID = feed.parent;
            while (parentID != rootFolderID) {
                if (folders.indexOf(parentID) == -1)
                    folders.push(parentID);
                parentID = gStorage.getFeed(parentID).parent;
            }
        }
        return folders;
    },


    onSelect: function gFeedList_onSelect(aEvent) {
        var selectedItem = this.selectedItem;

        if (!selectedItem || this.ignoreSelectEvent || this._prevSelectedItem == selectedItem)
            return;

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
            var folder = selectedItem.getAttribute('feedID');
            var query = new Query();
            query.folders = folder;
            gFeedView = new FeedView(title, query);
        }

        else {
            var feedID = selectedItem.getAttribute('feedID');
            var title = gStorage.getFeed(feedID).title;
            var query = new QuerySH(feedID, null, null);
            if (feedID)
                gFeedView = new FeedView(title, query);
        }
    },

    // Temporarily selects the target items of right-clicks, so to highlight
    // them when context menu is shown.
    onMouseDown: function gFeedList_onMouseDown(aEvent) {
        if (aEvent.button == 2) {
            var treeSelection = this.tree.view.selection;
            var row = this.tree.treeBoxObject.getRowAt(aEvent.clientX, aEvent.clientY);

            if (row >= 0 && !treeSelection.isSelected(row)) {

                // Don't highlight separators.
                var targetItem = this.tree.view.getItemAtIndex(row);
                if (targetItem.localName == 'treeseparator')
                    return;

                var saveCurrentIndex = treeSelection.currentIndex;
                treeSelection.selectEventsSuppressed = true;
                treeSelection.select(row);
                treeSelection.currentIndex = saveCurrentIndex;
                this.tree.treeBoxObject.ensureRowIsVisible(row);
                treeSelection.selectEventsSuppressed = false;
            }
        }
    },

    // This is used for detecting when a folder is open/closed and refreshing its label.
    onClick: function gFeedList_onClick(aEvent) {
        var row = this.tree.treeBoxObject.getRowAt(aEvent.clientX, aEvent.clientY);
        if (row != -1) {
            var item = this.tree.view.getItemAtIndex(row);
            if (item.hasAttribute('container'))
                this.refreshFolderTreeitems(item);
        }
        setTimeout(this._persistFolderState, 0);
    },

    // See onClick.
    onKeyUp: function gFeedList_onKeyUp(aEvent) {
        if (aEvent.keyCode == aEvent.DOM_VK_RETURN) {
            var selectedItem = this.selectedItem;
            if (selectedItem.hasAttribute('container'))
                this.refreshFolderTreeitems(selectedItem);
        }
        setTimeout(this._persistFolderState, 0);
    },

    // Sets the visibility of context menuitem depending on the target.
    onContextMenuShowing: function gFeedList_onContextMenuShowing(aEvent) {
        var row = this.tree.treeBoxObject.getRowAt(aEvent.clientX, aEvent.clientY);

        // If the target is an empty space, don't show the context menu.
        if (row == -1) {
            aEvent.preventDefault();
            return;
        }

        this.ctx_targetItem = this.tree.view.getItemAtIndex(row);

        // The target is a separator, don't show the context menu.
        if (this.ctx_targetItem.localName == 'treeseparator') {
            aEvent.preventDefault();
            return;
        }

        // Convenience variables telling what kind the target is.
        var targetIsFeed = this.ctx_targetItem.hasAttribute('url');
        var targetIsContainer = this.ctx_targetItem.hasAttribute('container');
        var targetIsUnreadFolder = this.ctx_targetItem.id == 'unread-folder';
        var targetIsStarredFolder = this.ctx_targetItem.id == 'starred-folder';
        var targetIsTrashFolder = this.ctx_targetItem.id == 'trash-folder';
        var targetIsSpecialFolder = targetIsUnreadFolder || targetIsStarredFolder ||
                                    targetIsTrashFolder;

        var markFeedRead = document.getElementById('ctx-mark-feed-read');
        markFeedRead.hidden = !targetIsFeed;

        var markFolderRead = document.getElementById('ctx-mark-folder-read');
        markFolderRead.hidden = !(targetIsContainer || targetIsSpecialFolder);

        var updateFeed = document.getElementById('ctx-update-feed');
        updateFeed.hidden = !targetIsFeed;

        var updateFolder = document.getElementById('ctx-update-folder');
        updateFolder.hidden = !targetIsContainer;

        var openWebsite = document.getElementById('ctx-open-website');
        openWebsite.hidden = !targetIsFeed;

        // Disable openWebsite if no websiteURL is available.
        if (targetIsFeed) {
            var feedID = this.ctx_targetItem.getAttribute('feedID');
            openWebsite.disabled = !gStorage.getFeed(feedID).websiteURL;
        }

        var propertiesSeparator = document.getElementById('ctx-properties-separator');
        propertiesSeparator.hidden = !targetIsFeed;

        var showProperties = document.getElementById('ctx-feed-properties');
        showProperties.hidden = !targetIsFeed;

        // Menuitems relating to deleting feeds and folders
        var dangerousSeparator = document.getElementById('ctx-dangerous-cmds-separator');
        dangerousSeparator.hidden = !(targetIsFeed || targetIsContainer ||
                                      targetIsUnreadFolder || targetIsTrashFolder);

        var deleteFeed = document.getElementById('ctx-delete-feed');
        deleteFeed.hidden = !targetIsFeed;

        var deleteFolder = document.getElementById('ctx-delete-folder');
        deleteFolder.hidden = !targetIsContainer;

        // Menuitems related to emptying feeds and folders
        var emptyFeed = document.getElementById('ctx-empty-feed');
        emptyFeed.hidden = !targetIsFeed;

        var emptyFolder = document.getElementById('ctx-empty-folder');
        emptyFolder.hidden = !(targetIsContainer || targetIsUnreadFolder);

        var restoreTrashed = document.getElementById('ctx-restore-trashed');
        restoreTrashed.hidden = !targetIsTrashFolder;

        var emptyTrash = document.getElementById('ctx-empty-trash');
        emptyTrash.hidden = !targetIsTrashFolder;
    },

    // Restores selection after it was temporarily changed to highlight the
    // context menu target.
    onContextMenuHiding: function gFeedList_onContextMenuHiding(aEvent) {
        var treeSelection = this.tree.view.selection;
        treeSelection.selectEventsSuppressed = true;
        treeSelection.select(treeSelection.currentIndex);
        treeSelection.selectEventsSuppressed = false;

        this.ctx_targetItem = null;
    },


    /**
     * Refreshes the label of a special folder.
     *
     * @param  aSpecialItem  Id if the special folder's treeitem.
     */
    refreshSpecialTreeitem: function gFeedList_refreshSpecialTreeitem(aSpecialItem) {
        var treeitem = document.getElementById(aSpecialItem);
        var treecell = treeitem.firstChild.firstChild;

        var query = new QuerySH(null, null, true);
        if (aSpecialItem == 'starred-folder')
            query.starred = true;
        else if (aSpecialItem == 'trash-folder')
            query.deleted = ENTRY_STATE_TRASHED;
        var unreadCount = query.getEntriesCount();

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
     * @param  aFolders  Either a single folder or an array of them, represented by
     *                   nsIBriefFeed object, feedID string, or treeitem XULElement.
     */
    refreshFolderTreeitems: function gFeedList_refreshFolderTreeitems(aFolders) {
        var treeitem, treecell, folder, query, unreadCount, label;
        var folders = aFolders instanceof Array ? aFolders : [aFolders];

        for (var i = 0; i < folders.length; i++) {
            folder = this.getBriefFeed(folders[i]);
            treeitem = this.getTreeitem(folders[i]);
            treecell = treeitem.firstChild.firstChild;

            if (treeitem.getAttribute('open') == 'true') {
                label = folder.title;
                this.removeProperty(treecell, 'unread');
            }
            else {
                query = new Query();
                query.folders = folder.feedID;
                query.unread = true;
                unreadCount = query.getEntriesCount();

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
     * Refresh the feed treeitem's label and favicon. Also refreshes folders in the feed's
     * parent chain.
     *
     * @param  aFeeds  Either a single feed or an array of them, represented by
     *                 nsIBriefFeed object, feedID string, or treeitem XULElement.
     */
    refreshFeedTreeitems: function gFeedList_refreshFeedTreeitems(aFeeds) {
        var feed, treeitem, treecell, query, unreadCount, label, iconURL, favicon;
        var feeds = aFeeds instanceof Array ? aFeeds : [aFeeds];

        for (var i = 0; i < feeds.length; i++) {
            feed = this.getBriefFeed(feeds[i]);
            treeitem = this.getTreeitem(feeds[i]);
            treecell = treeitem.firstChild.firstChild;

            // Update the label.
            query = new QuerySH(feed.feedID, null, true);
            unreadCount = query.getEntriesCount();
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

        // |this.items| is null before the tree finishes building. We don't need to
        // refresh the parent folders then, anyway, because _buildFolderChildren does
        // it itself.
        if (this.items) {
            var folders = this.getFoldersForFeeds(aFeeds);
            this.refreshFolderTreeitems(folders);
        }
    },


    // Rebuilds the feedlist tree.
    rebuild: function gFeedList_rebuild() {
        this.tree = document.getElementById('feed-list');
        var topLevelChildren = document.getElementById('top-level-children');

        this.refreshSpecialTreeitem('unread-folder');
        this.refreshSpecialTreeitem('starred-folder');
        this.refreshSpecialTreeitem('trash-folder');

        // Clear the existing tree.
        var lastChild = topLevelChildren.lastChild;
        while (lastChild.id != 'special-folders-separator') {
            topLevelChildren.removeChild(lastChild);
            lastChild = topLevelChildren.lastChild
        }

        this.feeds = gStorage.getFeedsAndFolders({});

        // This a helper array used by _buildFolderChildren. As the function recurses,
        // the array stores the <treechildren> elements of all folders in the parent chain
        // of the currently processed folder. This is how it tracks where to append the
        // items.
        this._folderParentChain = [topLevelChildren];

        var rootURI = gPrefs.getCharPref('liveBookmarksFolder');
        this._buildFolderChildren(hashString(rootURI));

        // Fill the items cache.
        this.items = this.tree.getElementsByTagName('treeitem');
    },

    /**
     * Recursively reads feeds from the database and builds the tree, starting from the
     * given folder.
     *
     * @param aParentFolder feedID of the folder.
     */
    _buildFolderChildren: function gFeedList__buildFolderChildren(aParentFolder) {

        // Iterate over all the children.
        for (var i = 0; i < this.feeds.length; i++) {
            var feed = this.feeds[i];

            if (feed.parent != aParentFolder)
                continue;

            if (feed.isFolder) {
                var prevParent = this._folderParentChain[this._folderParentChain.length - 1];
                var closedFolders = this.tree.getAttribute('closedFolders');
                var isOpen = !closedFolders.match(feed.feedID);

                var treeitem = document.createElement('treeitem');
                treeitem.setAttribute('container', 'true');
                treeitem.setAttribute('open', isOpen);
                treeitem.setAttribute('feedID', feed.feedID);
                treeitem = prevParent.appendChild(treeitem);

                var treerow = document.createElement('treerow');
                treerow = treeitem.appendChild(treerow);

                var treecell = document.createElement('treecell');
                treecell = treerow.appendChild(treecell);

                this.refreshFolderTreeitems(treeitem);

                var treechildren = document.createElement('treechildren');
                treechildren = treeitem.appendChild(treechildren);

                this._folderParentChain.push(treechildren);

                this._buildFolderChildren(feed.feedID);
            }

            else {
                var parent = this._folderParentChain[this._folderParentChain.length - 1];

                var treecell = document.createElement('treecell');
                treecell.setAttribute('properties', 'feed-item '); // Mind the whitespace

                var treerow = document.createElement('treerow');
                treerow.appendChild(treecell);

                var treeitem = document.createElement('treeitem');
                treeitem.setAttribute('feedID', feed.feedID);
                treeitem.setAttribute('url', feed.feedURL);
                treeitem.appendChild(treerow);

                parent.appendChild(treeitem);

                this.refreshFeedTreeitems(treeitem);
            }
        }
        this._folderParentChain.pop();
    },


    observe: function gFeedList_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

        // The Live Bookmarks stored is user's folder of choice were read and the
        // in-database list of feeds was synchronized.
        case 'brief:invalidate-feedlist':
            this.rebuild();
            if (gFeedView)
                setTimeout(function(){ gFeedView.ensure() }, 0);
            var deck = document.getElementById('feed-list-deck');
            deck.selectedIndex = 0;
            break;

        case 'brief:feed-title-changed':
            var feed = gStorage.getFeed(aData);
            if (feed.isFolder)
                this.refreshFolderTreeitems(feed);
            else
                this.refreshFeedTreeitems(aData);
            break;
        }
    },

    _persistFolderState: function gFeedList_persistFolderState() {
        // Persist the folders open/closed state.
        var items = gFeedList.tree.getElementsByTagName('treeitem');
        var closedFolders = '';
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.hasAttribute('container') && item.getAttribute('open') == 'false')
                closedFolders += item.getAttribute('feedID');
        }
        gFeedList.tree.setAttribute('closedFolders', closedFolders);
    },


    /**
     * Sets a property on a content tree item.
     *
     * Trees cannot be styled using normal DOM attributes and "properties" attribute
     * whose value contains space-separated pseudo-attributes has to be used
     * instead. This is a convenience function to make setting a property work
     * the same and be as easy as setting an attribute.
     *
     * @param aItem     Subject tree element.
     * @param aProperty Property to be set.
     */
    setProperty: function gFeedList_setProperty(aItem, aProperty) {
        var properties = aItem.getAttribute('properties');
        if (!properties.match(aProperty + ' '))
            aItem.setAttribute('properties', properties + aProperty + ' ');
    },

    // Cf. with |setProperty|
    removeProperty: function gFeedList_removeProperty(aItem, aProperty) {
        var properties = aItem.getAttribute('properties');
        if (properties.match(aProperty)) {
            properties = properties.replace(aProperty + ' ', '');
            aItem.setAttribute('properties', properties);
        }
    },

    // Cf. with |setProperty|
    hasProperty: function gFeedList_hasProperty(aItem, aProperty) {
        var properties = aItem.getAttribute('properties');
        return properties.match(aProperty) ? true : false;
    }

}


// Feed list context menu commands.
var gContextMenuCommands = {

    markFeedRead: function ctxMenuCmds_markFeedRead(aEvent) {
        var item = gFeedList.ctx_targetItem;
        var feedID = gFeedList.ctx_targetItem.getAttribute('feedID');
        var query = new QuerySH(feedID, null, null);
        query.markEntriesRead(true);
    },


    markFolderRead: function ctxMenuCmds_markFolderRead(aEvent) {
        var targetItem = gFeedList.ctx_targetItem;

        if (targetItem.hasAttribute('specialFolder')) {
            var query = new Query();
            if (targetItem.id == 'unread-folder')
                query.unread = true;
            else if (targetItem.id == 'starred-folder')
                query.starred = true;
            else
                query.deleted = ENTRY_STATE_TRASHED;
            query.markEntriesRead(true);
        }
        else {
            var query = new Query();
            query.folders = targetItem.getAttribute('feedID');
            query.markEntriesRead(true);
        }
    },


    updateFeed: function ctxMenuCmds_updateFeed(aEvent) {
        var feedID = gFeedList.ctx_targetItem.getAttribute('feedID');
        var feed = gStorage.getFeed(feedID);
        gUpdateService.fetchFeeds([feed], 1, false);
    },


    updateFolder: function ctxMenuCmds_updateFolder(aEvent) {
        var treeitems = gFeedList.ctx_targetItem.getElementsByTagName('treeitem');
        var feedID, i, feeds = [];
        for (i = 0; i < treeitems.length; i++) {
            if (!treeitems[i].hasAttribute('container')) {
                feedID = treeitems[i].getAttribute('feedID');
                feeds.push(gStorage.getFeed(feedID));
            }
        }

        gUpdateService.fetchFeeds(feeds, feeds.length, false);
        var deck = document.getElementById('update-buttons-deck');
        deck.selectedIndex = 1;
    },


    openWebsite: function ctxMenuCmds_openWebsite(aEvent) {
        var feedID = gFeedList.ctx_targetItem.getAttribute('feedID');
        var url = gStorage.getFeed(feedID).websiteURL;
        gTopBrowserWindow.gBrowser.loadOneTab(url);
    },


    emptyFeed: function ctxMenuCmds_emptyFeed(aEvent) {
        var feedID = gFeedList.ctx_targetItem.getAttribute('feedID');
        var query = new QuerySH(feedID, null, null);
        query.unstarred = true;
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },


    emptyFolder: function ctxMenuCmds_emptyFolder(aEvent) {
        var targetItem = gFeedList.ctx_targetItem;

        if (targetItem.id == 'unread-folder') {
            var query = new Query();
            query.unstarred = true;
            query.unread = true;
            query.deleteEntries(ENTRY_STATE_TRASHED);
        }
        else {
            var query = new Query();
            query.folders = targetItem.getAttribute('feedID');
            query.unstarred = true;
            query.deleteEntries(ENTRY_STATE_TRASHED);
        }
    },


    restoreTrashed: function ctxMenuCmds_restoreTrashed(aEvent) {
        var query = new Query();
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_NORMAL);
    },


    emptyTrash: function ctxMenuCmds_emptyTrash(aEvent) {
        var query = new Query();
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_DELETED);
    },


    deleteFeed: function ctxMenuCmds_deleteFeed(aEvent) {
        var feedID = gFeedList.ctx_targetItem.getAttribute('feedID');
        var feed = gStorage.getFeed(feedID);

        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var stringbundle = document.getElementById('main-bundle');
        var title = stringbundle.getString('confirmFeedDeletionTitle');
        var text = stringbundle.getFormattedString('confirmFeedDeletionText', [feed.title]);
        var weHaveAGo = promptService.confirm(window, title, text);

        if (weHaveAGo) {
            var item = gFeedList.getTreeitem(feedID);

            // If the currently selected feed is being removed, select the next one.
            if (gFeedList.selectedItem == item) {
                var currentIndex = gFeedList.tree.view.selection.currentIndex;
                gFeedList.tree.view.selection.select(currentIndex + 1);
            }

            // The treeitem would be removed anyway thanks to RDFObserver,
            // but we do it here to give faster visual feedback.
            item.parentNode.removeChild(item);

            var node = RDF.GetResource(feed.rdf_uri);
            var parent = BMSVC.getParent(node);
            RDFC.Init(BMDS, parent);
            var index = RDFC.IndexOf(node);
            var propertiesArray = new Array(gBmProperties.length);
            BookmarksUtils.getAllChildren(node, propertiesArray);

            gBkmkTxnSvc.createAndCommitTxn(Ci.nsIBookmarkTransactionManager.REMOVE,
                                           'delete', node, index, parent,
                                           propertiesArray.length, propertiesArray);
            BookmarksUtils.flushDataSource();
        }
    },


    deleteFolder: function ctxMenuCmds_deleteFolder(aEvent) {
        var folderFeedID = gFeedList.ctx_targetItem.getAttribute('feedID');
        var folder = gStorage.getFeed(folderFeedID);

        // Ask for confirmation.
        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var stringbundle = document.getElementById('main-bundle');
        var title = stringbundle.getString('confirmFolderDeletionTitle');
        var text = stringbundle.getFormattedString('confirmFolderDeletionText', [folder.title]);
        var weHaveAGo = promptService.confirm(window, title, text);

        if (weHaveAGo) {
            var item = gFeedList.getTreeitem(folderFeedID);

            // XXX If the currently selected item is being removed, we have to select
            // another one. Ideally we would select the next sibling but I couldn't get
            // it to work reliably, so for now the Unread folder gets selected.
            if (gFeedList.selectedItem == item)
                gFeedList.tree.view.selection.select(0);

            // The treeitem would have been removed anyway thanks to RDFObserver,
            // but we do it here to give faster visual feedback.
            item.parentNode.removeChild(item);

            var treeitems = gFeedList.ctx_targetItem.getElementsByTagName('treeitem');

            gBkmkTxnSvc.startBatch();

            // Delete all the descendant feeds and folder.
            var feedID, feed, node, parent, index, propertiesArray;
            for (var i = 0; i < treeitems.length; i++) {
                feedID = treeitems[i].getAttribute('feedID');
                feed = gStorage.getFeed(feedID);

                node = RDF.GetResource(feed.rdf_uri);
                parent = BMSVC.getParent(node);
                RDFC.Init(BMDS, parent);
                index = RDFC.IndexOf(node);
                propertiesArray = new Array(gBmProperties.length);
                BookmarksUtils.getAllChildren(node, propertiesArray);
                gBkmkTxnSvc.createAndCommitTxn(Ci.nsIBookmarkTransactionManager.REMOVE,
                                               'delete', node, index, parent,
                                               propertiesArray.length, propertiesArray);
            }

            // Delete the target folder.
            node = RDF.GetResource(folder.rdf_uri);
            parent = BMSVC.getParent(node);
            RDFC.Init(BMDS, parent);
            index = RDFC.IndexOf(node);
            propertiesArray = new Array(gBmProperties.length);
            BookmarksUtils.getAllChildren(node, propertiesArray);
            gBkmkTxnSvc.createAndCommitTxn(Ci.nsIBookmarkTransactionManager.REMOVE,
                                           'delete', node, index, parent,
                                           propertiesArray.length, propertiesArray);

            gBkmkTxnSvc.endBatch();
            BookmarksUtils.flushDataSource();
        }
    },


    showFeedProperties: function ctxMenuCmds_showFeedProperties(aEvent) {
        var feedID = gFeedList.ctx_targetItem.getAttribute('feedID');

        openDialog('chrome://brief/content/feed-properties.xul', 'FeedProperties',
                   'chrome,titlebar,toolbar,centerscreen,modal', feedID);
    }

}

function hashString(aString) {

    // nsICryptoHash can read the data either from an array or a stream.
    // Creating a stream ought to be faster than converting a long string
    // into an array using JS.
    // XXX nsIStringInputStream doesn't work well with UTF-16 strings; it's
    // lossy, so it increases the risk of collisions.
    // nsIScriptableUnicodeConverter.convertToInputStream should be used instead.
    var stringStream = Cc["@mozilla.org/io/string-input-stream;1"].
                       createInstance(Ci.nsIStringInputStream);
    stringStream.setData(aString, aString.length);

    var hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
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