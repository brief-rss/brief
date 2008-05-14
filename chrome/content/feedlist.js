const THROBBER_URL = 'chrome://global/skin/throbber/Throbber-small.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';

var gFeedList = {

    get tree gFeedList_tree() {
        delete this.tree;
        return this.tree = getElement('feed-list');
    },

    items: null,  // All treeitems in the tree.

    _prevSelectedItem: null,

    // If TRUE, prevents the onSelect function from running when
    // "select" event is occurs.
    ignoreSelectEvent: false,

    // Flag set when the sidebar was hidden and the tree wasn't built,
    // so that we know to rebuild it when unhiding the sidebar.
    treeNotBuilt: false,


    // Currently selected treeitem.
    get selectedItem gFeedList_selectedItem() {
        var item = null;
        var currentIndex = this.tree.currentIndex;
        if (currentIndex != -1 && currentIndex < this.tree.view.rowCount)
            item = this.tree.view.getItemAtIndex(currentIndex);
        return item;
    },

    // nsIBriefFeed object of the the currently selected feed, or null.
    get selectedFeed gFeedList_selectedFeed() {
        if (!this.selectedItem)
            return null;

        var feed = null;
        var feedID = this.selectedItem.id;
        if (feedID)
            feed = gStorage.getFeed(feedID);
        return feed;
    },

    /**
     * Gets nsIBriefFeed representation of a given feed. We've got feeds floating around
     * represented in at least 3 different ways: nsIBriefFeed's, ID's of feeds, and
     * treeitems. This function allows us to ensure that the argument is of nsIBriefFeed
     * type. It makes it easy for other methods of gFeedList to accept any arguments
     * of any type.
     *
     * @param aFeed nsIBriefFeed object, feedID string, or treeitem XULElement.
     */
    getBriefFeed: function gFeedList_getBriefFeed(aFeed) {
        if (aFeed instanceof Ci.nsIBriefFeed)
            return aFeed;

        var feedID;
        if (typeof aFeed == 'string')
            feedID = aFeed;
        else if (aFeed instanceof XULElement)
            feedID = aFeed.id;

        return gStorage.getFeed(feedID);
    },

    /**
     * Returns an array of IDs of folders in the the parent chains of the given feeds.
     *
     * @param aFeeds  A feed or an array of feeds, represented by
     *                nsIBriefFeed object, feedID string, or treeitem XULElement.
     * @returns Array of IDs of folders.
     */
    getFoldersForFeeds: function gFeedList_getFoldersForFeeds(aFeeds) {
        var folders = [];
        var root = gPrefs.homeFolder;

        // See refreshFeedTreeitems()
        var feeds = (aFeeds.splice) ? aFeeds : [aFeeds];

        for (var i = 0; i < feeds.length; i++) {
            var feed = this.getBriefFeed(feeds[i]);
            var parentID = feed.parent;
            while (parentID != root) {
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
            var view = new FeedView(title, query);
        }

        else if (selectedItem.hasAttribute('container')) {
            var feed = this.selectedFeed;
            query = new Query();
            query.folders = [feed.feedID];
            view = new FeedView(feed.title, query);
        }

        else {
            var feed = this.selectedFeed;
            query = new QuerySH([feed.feedID], null, null);
            view = new FeedView(feed.title, query);
        }

        view.attach();
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


    onClick: function gFeedList_onClick(aEvent) {
        var row = this.tree.treeBoxObject.getRowAt(aEvent.clientX, aEvent.clientY);
        if (row != -1) {
            var item = this.tree.view.getItemAtIndex(row);

            // Detect when folder is collapsed/expanded.
            if (item.hasAttribute('container')) {
                this.refreshFolderTreeitems(item);

                // We have to persist folders immediatelly instead of when Brief is closed,
                // because otherwise if the feedlist was rebuilt, the changes would be lost.
                async(this._persistFolderState, 0, this);
            }

            // If there is a webpage open in the browser then clicking on
            // the already selected item, should bring back the feed view.
            if (!gFeedView.isActive && item == this.selectedItem && aEvent.button == 0)
                gFeedView.browser.loadURI(gTemplateURI.spec);
        }
    },


    onKeyUp: function gFeedList_onKeyUp(aEvent) {
        var isContainer = this.selectedItem.hasAttribute('container');
        if (isContainer && aEvent.keyCode == aEvent.DOM_VK_RETURN) {
            this.refreshFolderTreeitems(this.selectedItem);
            async(this._persistFolderState, 0, this);
        }
    },

    // Sets the visibility of context menuitem depending on the target.
    onContextMenuShowing: function gFeedList_onContextMenuShowing(aEvent) {
        var row = this.tree.treeBoxObject.getRowAt(aEvent.clientX, aEvent.clientY);

        if (row == -1) {
            // If the target is an empty space, don't show the context menu.
            aEvent.preventDefault();
        }
        else {
            var target = this.tree.view.getItemAtIndex(row);

            if (target.localName == 'treeseparator')
                aEvent.preventDefault();
            else
                gContextMenu.init(target);
        }
    },

    // Restores selection after it was temporarily changed to highlight the
    // context menu target.
    onContextMenuHiding: function gFeedList_onContextMenuHiding(aEvent) {
        var treeSelection = this.tree.view.selection;
        this.ignoreSelectEvent = true;
        treeSelection.select(treeSelection.currentIndex);
        this.ignoreSelectEvent = false;
    },


    /**
     * Refreshes the label of a special folder.
     *
     * @param  aSpecialItem  Id if the special folder's treeitem.
     */
    refreshSpecialTreeitem: function gFeedList_refreshSpecialTreeitem(aSpecialItem) {
        var treeitem = getElement(aSpecialItem);
        var treecell = treeitem.firstChild.firstChild;

        var query = new QuerySH(null, null, true);
        if (aSpecialItem == 'starred-folder')
            query.starred = true;
        else if (aSpecialItem == 'trash-folder')
            query.deleted = ENTRY_STATE_TRASHED;
        var unreadCount = query.getEntryCount();

        var name = treeitem.getAttribute('title');

        this._setLabel(treecell, name, unreadCount);
    },

    /**
     * Refresh the folder's label.
     *
     * @param  aFolders  Either a single folder or an array of them, represented by
     *                   nsIBriefFeed object, feedID string, or treeitem XULElement.
     */
    refreshFolderTreeitems: function gFeedList_refreshFolderTreeitems(aFolders) {
        var treeitem, treecell, folder, query, unreadCount;
        var folders = aFolders instanceof Array ? aFolders : [aFolders];

        for (var i = 0; i < folders.length; i++) {
            folder = this.getBriefFeed(folders[i]);
            treeitem = getElement(folder.feedID);
            treecell = treeitem.firstChild.firstChild;

            if (treeitem.getAttribute('open') == 'true') {
                this.removeProperty(treecell, 'unread');
                treecell.setAttribute('label', folder.title);
            }
            else {
                query = new Query();
                query.folders = [folder.feedID];
                query.unread = true;
                unreadCount = query.getEntryCount();

                this._setLabel(treecell, folder.title, unreadCount);
            }
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
        var feed, treeitem, treecell, query, unreadCount;

        // XXX Hack: arrays that traveled through XPConnect aren't instanceof Array,
        // so we use the splice method to check if aFeeds is an array.
        var feeds = (aFeeds.splice) ? aFeeds : [aFeeds];

        for (var i = 0; i < feeds.length; i++) {
            feed = this.getBriefFeed(feeds[i]);
            treeitem = getElement(feed.feedID);
            treecell = treeitem.firstChild.firstChild;

            // Update the label.
            query = new QuerySH([feed.feedID], null, true);
            unreadCount = query.getEntryCount();
            this._setLabel(treecell, feed.title, unreadCount);

            // Update the favicon.
            if (treeitem.hasAttribute('loading'))
                treecell.setAttribute('src', THROBBER_URL);
            else if (treeitem.hasAttribute('error'))
                treecell.setAttribute('src', ERROR_ICON_URL);
            else if (feed.favicon != 'no-favicon')
                treecell.setAttribute('src', feed.favicon);
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

    _setLabel: function gFeedList__setUnreadCounter(aTreecell, aName, aUnreadCount) {
        var label;
        if (aUnreadCount > 0) {
            label = aName + ' (' + aUnreadCount +')';
            this.setProperty(aTreecell, 'unread');
        }
        else {
            label = aName;
            this.removeProperty(aTreecell, 'unread');
        }
        aTreecell.setAttribute('label', label);
    },


    // Rebuilds the feedlist tree.
    rebuild: function gFeedList_rebuild() {

        // Can't build the tree if the tree is hidden and there's no view.
        if (!this.tree.view) {
            this.treeNotBuilt = true;
            return;
        }
        this.treeNotBuilt = false;

        this.refreshSpecialTreeitem('unread-folder');
        this.refreshSpecialTreeitem('starred-folder');
        this.refreshSpecialTreeitem('trash-folder');

        // Preserve selection.
        if (this.selectedFeed)
            this.feedIDToSelect = this.selectedFeed.feedID;

        // Clear the existing tree.
        var topLevelChildren = getElement('top-level-children');
        var lastChild = topLevelChildren.lastChild;
        while (lastChild.id != 'special-folders-separator') {
            topLevelChildren.removeChild(lastChild);
            lastChild = topLevelChildren.lastChild
        }

        this.feeds = gStorage.getAllFeedsAndFolders();

        // This a helper array used by _buildFolderChildren. As the function recurses,
        // the array stores the <treechildren> elements of all folders in the parent chain
        // of the currently processed folder. This is how it tracks where to append the
        // items.
        this._folderParentChain = [topLevelChildren];

        this._buildFolderChildren(gPrefs.homeFolder);

        // Fill the items cache.
        this.items = this.tree.getElementsByTagName('treeitem');
    },

    // Cached document fragments, "bricks" used to build the tree.
    get _folderRow gFeedList__folderRow() {
        delete this._folderRow;

        this._folderRow = document.createDocumentFragment();

        var treeitem = document.createElement('treeitem');
        treeitem.setAttribute('container', 'true');
        treeitem = this._folderRow.appendChild(treeitem);

        var treerow = document.createElement('treerow');
        treerow = treeitem.appendChild(treerow);

        var treecell = document.createElement('treecell');
        treecell = treerow.appendChild(treecell);

        var treechildren = document.createElement('treechildren');
        treechildren = treeitem.appendChild(treechildren);

        return this._folderRow;
    },

    get _feedRow gFeedList__feedRow() {
        delete this._feedRow;

        this._feedRow = document.createDocumentFragment();

        var treeitem = document.createElement('treeitem');
        treeitem = this._feedRow.appendChild(treeitem);

        var treerow = document.createElement('treerow');
        treerow.setAttribute('properties', 'feed-item ');
        treeitem.appendChild(treerow);

        var treecell = document.createElement('treecell');
        treecell.setAttribute('properties', 'feed-item '); // Mind the whitespace
        treerow.appendChild(treecell);

        return this._feedRow;
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
                var parent = this._folderParentChain[this._folderParentChain.length - 1];
                var closedFolders = this.tree.getAttribute('closedFolders');
                var isOpen = !closedFolders.match(escape(feed.feedID));

                var fragment = this._folderRow.cloneNode(true);
                var treeitem = fragment.firstChild;
                treeitem.setAttribute('open', isOpen);
                treeitem.setAttribute('id', feed.feedID);

                parent.appendChild(fragment);

                if (feed.feedID == this.feedIDToSelect) {
                    this.ignoreSelectEvent = true;
                    this.tree.view.selection.select(this.tree.view.rowCount - 1);
                    this.ignoreSelectEvent = false;
                    this.feedIDToSelect = null;
                }

                this.refreshFolderTreeitems(treeitem);

                this._folderParentChain.push(treeitem.lastChild);

                this._buildFolderChildren(feed.feedID);
            }

            else {
                var parent = this._folderParentChain[this._folderParentChain.length - 1];

                var fragment = this._feedRow.cloneNode(true);
                var treeitem = fragment.firstChild;
                treeitem.setAttribute('id', feed.feedID);
                treeitem.setAttribute('url', feed.feedURL);

                parent.appendChild(fragment);

                if (feed.feedID == this.feedIDToSelect) {
                    this.ignoreSelectEvent = true;
                    this.tree.view.selection.select(this.tree.view.rowCount - 1);
                    this.ignoreSelectEvent = false;
                    this.feedIDToSelect = null;
                }

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
            async(gFeedView.refresh, 0, gFeedView);

            if (gPrefs.homeFolder)
                getElement('feed-list-deck').selectedIndex = 0;
            else
                showHomeFolderPicker();

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


    onEntriesAdded: function gFeedList_onEntriesAdded(aEntries) {
        async(function() {
            var feeds = filterDuplicates(aEntries.feedIDs);
            this.refreshFeedTreeitems(feeds);

            this.refreshSpecialTreeitem('unread-folder');

        }, 0, this)
    },

    onEntriesUpdated: function gFeedList_onEntriesUpdated(aEntries) {
        async(function() {
            var feeds = filterDuplicates(aEntries.feedIDs);
            this.refreshFeedTreeitems(feeds);

            this.refreshSpecialTreeitem('unread-folder');

        }, 0, this)
    },

    onEntriesMarkedRead: function gFeedList_onEntriesMarkedRead(aEntries, aNewState) {
        async(function() {
            var feeds = filterDuplicates(aEntries.feedIDs);
            this.refreshFeedTreeitems(feeds);

            this.refreshSpecialTreeitem('unread-folder');

            if (!aEntries.starred || aEntries.starred.indexOf(true))
                this.refreshSpecialTreeitem('starred-folder');

            if (!aEntries.deleted || aEntries.deleted.indexOf(ENTRY_STATE_TRASHED))
                this.refreshSpecialTreeitem('trash-folder');

        }, 0, this)
    },

    onEntriesStarred: function gFeedList_onEntriesStarred(aEntries, aNewState) {
        async(this.refreshSpecialTreeitem, 0, this, 'starred-folder');
    },

    onEntriesTagged: function gFeedList_onEntriesTagged(aEntries) {

    },

    onEntriesDeleted: function gFeedList_onEntriesDeleted(aEntries, aNewState) {
        async(function() {
            var feeds = filterDuplicates(aEntries.feedIDs);
            this.refreshFeedTreeitems(feeds);

            this.refreshSpecialTreeitem('trash-folder');

            if (!aEntries.read || aEntries.read.indexOf(false))
                this.refreshSpecialTreeitem('unread-folder');
            if (!aEntries.starred || aEntries.starred.indexOf(true))
                this.refreshSpecialTreeitem('starred-folder');

        }, 0, this)
    },


    _persistFolderState: function gFeedList_persistFolderState() {
        // Persist the folders open/closed state.
        var items = gFeedList.tree.getElementsByTagName('treeitem');
        var closedFolders = '';
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.hasAttribute('container') && item.getAttribute('open') == 'false')
                closedFolders += item.id;
        }
        gFeedList.tree.setAttribute('closedFolders', escape(closedFolders));
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
    },

    QueryInterface: function gFeedList_QueryInterface(aIID) {
        if (aIID.equals(Ci.nsISupports) ||
            aIID.equals(Ci.nsIObserver) ||
            aIID.equals(Ci.nsIBriefStorageObserver)) {
            return this;
        }
        throw Components.results.NS_ERROR_NO_INTERFACE;
    }

}



var gContextMenu = {

    targetItem: null,

    get targetID() this.targetItem.id,
    get targetFeed() gStorage.getFeed(this.targetID),

    get targetIsFeed()          this.targetItem.hasAttribute('url'),
    get targetIsContainer()     this.targetItem.hasAttribute('container'),
    get targetIsUnreadFolder()  this.targetItem.id == 'unread-folder',
    get targetIsStarredFolder() this.targetItem.id == 'starred-folder',
    get targetIsTrashFolder()   this.targetItem.id == 'trash-folder',
    get targetIsSpecialFolder() this.targetIsUnreadFolder || this.targetIsStarredFolder
                                || this.targetIsTrashFolder,


    init: function gContextMenu_init(aTargetItem) {
        this.targetItem = aTargetItem;

        getElement('ctx-mark-feed-read').hidden = !this.targetIsFeed;
        getElement('ctx-mark-folder-read').hidden = !this.targetIsContainer &&
                                                    !this.targetIsSpecialFolder;
        getElement('ctx-update-feed').hidden = !this.targetIsFeed;
        getElement('ctx-update-folder').hidden = !this.targetIsContainer;

        var openWebsite = getElement('ctx-open-website');
        openWebsite.hidden = !this.targetIsFeed;
        if (this.targetIsFeed)
            openWebsite.disabled = !gStorage.getFeed(this.targetItem.id).websiteURL;

        getElement('ctx-properties-separator').hidden = !this.targetIsFeed;
        getElement('ctx-feed-properties').hidden = !this.targetIsFeed;

        // Menuitems related to deleting feeds and folders.
        var dangerousSeparator = getElement('ctx-dangerous-cmds-separator');
        dangerousSeparator.hidden = !(this.targetIsFeed || this.targetIsContainer ||
                                      this.targetIsUnreadFolder || this.targetIsTrashFolder);
        getElement('ctx-delete-feed').hidden = !this.targetIsFeed;
        getElement('ctx-delete-folder').hidden = !this.targetIsContainer;

        // Menuitems related to emptying feeds and folders.
        getElement('ctx-empty-feed').hidden = !this.targetIsFeed;
        getElement('ctx-empty-folder').hidden = !(this.targetIsContainer || this.targetIsUnreadFolder);
        getElement('ctx-restore-trashed').hidden = !this.targetIsTrashFolder;
        getElement('ctx-empty-trash').hidden = !this.targetIsTrashFolder;

    },


    markFeedRead: function gContextMenu_markFeedRead() {
        var query = new QuerySH([this.targetID], null, null);
        query.markEntriesRead(true);
    },


    markFolderRead: function gContextMenu_markFolderRead() {
        var query = new Query();

        if (this.targetIsUnreadFolder)
            query.unread = true;
        else if (this.targetIsStarredFolder)
            query.starred = true;
        else if (this.targetIsTrashFolder)
            query.deleted = ENTRY_STATE_TRASHED;
        else
            query.folders = [this.targetID];

        query.markEntriesRead(true);
    },


    updateFeed: function gContextMenu_updateFeed() {
        gUpdateService.updateFeeds([this.targetFeed]);
    },


    updateFolder: function gContextMenu_updateFolder() {
        var items = this.targetItem.getElementsByTagName('treeitem');
        var feeds = [];

        for (let i = 0; i < items.length; i++) {
            if (!items[i].hasAttribute('container'))
                feeds.push(gStorage.getFeed(items[i].id));
        }

        gUpdateService.updateFeeds(feeds);
    },


    openWebsite: function gContextMenu_openWebsite() {
        var url = this.targetFeed.websiteURL;
        gTopWindow.gBrowser.loadOneTab(url);
    },


    emptyFeed: function gContextMenu_emptyFeed() {
        var query = new QuerySH([this.targetID], null, null);
        query.unstarred = true;
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },


    emptyFolder: function gContextMenu_emptyFolder() {
        var query = new Query();
        query.unstarred = true;

        if (this.targetIsUnreadFolder)
            query.unread = true;
        else
            query.folders = [this.targetID];

        query.deleteEntries(ENTRY_STATE_TRASHED);
    },


    restoreTrashed: function gContextMenu_restoreTrashed() {
        var query = new Query();
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_NORMAL);
    },


    emptyTrash: function gContextMenu_emptyTrash() {
        var query = new Query();
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_DELETED);

        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);

        var bundle = getElement('main-bundle');
        var dialogTitle = bundle.getString('compactPromptTitle');
        var dialogText = bundle.getString('compactPromptText');
        var dialogConfirmLabel = bundle.getString('compactPromptConfirmButton');

        var buttonFlags = promptService.BUTTON_POS_0 * promptService.BUTTON_TITLE_IS_STRING +
                          promptService.BUTTON_POS_1 * promptService.BUTTON_TITLE_NO +
                          promptService.BUTTON_POS_0_DEFAULT;

        var shouldCompact = promptService.confirmEx(window, dialogTitle, dialogText,
                                                    buttonFlags, dialogConfirmLabel,
                                                    null, null, null, {value:0});

        if (shouldCompact === 0) {
            window.openDialog('chrome://brief/content/compacting-progress.xul', 'Brief',
                              'chrome,titlebar,centerscreen');
        }
    },


    deleteFeed: function gContextMenu_deleteFeed() {
        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var stringbundle = getElement('main-bundle');
        var title = stringbundle.getString('confirmFeedDeletionTitle');
        var text = stringbundle.getFormattedString('confirmFeedDeletionText',
                                                   [this.targetFeed.title]);
        var weHaveAGo = promptService.confirm(window, title, text);

        if (weHaveAGo) {
            this._removeTreeitem(this.targetItem);
            this._deleteBookmarks([this.targetFeed]);
        }
    },


    deleteFolder: function gContextMenu_deleteFolder() {
        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var stringbundle = getElement('main-bundle');
        var title = stringbundle.getString('confirmFolderDeletionTitle');
        var text = stringbundle.getFormattedString('confirmFolderDeletionText',
                                                   [this.targetFeed.title]);
        var weHaveAGo = promptService.confirm(window, title, text);

        if (weHaveAGo) {
            this._removeTreeitem(this.targetItem);

            var items = this.targetItem.getElementsByTagName('treeitem');
            var feeds = [this.targetFeed];
            for (let i = 0; i < items.length; i++)
                feeds.push(gStorage.getFeed(items[i].id));

            this._deleteBookmarks(feeds);
        }
    },


    // Removes a treeitem and updates selection if it was selected.
    _removeTreeitem: function gContextMenu__removeTreeitem(aTreeitem) {
        var treeview = gFeedList.tree.view;
        var currentIndex = treeview.selection.currentIndex;
        var rowCount = treeview.rowCount;
        var indexToSelect = -1;

        if (gFeedList.selectedItem == aTreeitem) {
            if (currentIndex == rowCount - 1)
                indexToSelect = treeview.getIndexOfItem(aTreeitem.previousSibling);
            else if (currentIndex != 3)
                indexToSelect = currentIndex; // Don't select the separator.
            else
                indexToSelect = 0;
        }

        aTreeitem.parentNode.removeChild(aTreeitem);

        if (indexToSelect != -1)
            async(treeview.selection.select, 0, treeview.selection, indexToSelect);
    },


    _deleteBookmarks: function gContextMenu__deleteBookmarks(aFeeds) {
        var transactionsService = Cc['@mozilla.org/browser/placesTransactionsService;1'].
                                  getService(Ci.nsIPlacesTransactionsService);

        var transactions = [];
        for (var i = aFeeds.length - 1; i >= 0; i--)
            transactions.push(transactionsService.removeItem(aFeeds[i].bookmarkID));

        var txn = transactionsService.aggregateTransactions('Remove items', transactions);
        transactionsService.doTransaction(txn);
    },


    showFeedProperties: function gContextMenu_showFeedProperties() {
        openDialog('chrome://brief/content/options/feed-properties.xul', 'FeedProperties',
                   'chrome,titlebar,toolbar,centerscreen,modal', this.targetID);
    }

}
