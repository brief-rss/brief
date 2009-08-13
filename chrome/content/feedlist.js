const THROBBER_URL = 'chrome://global/skin/throbber/Throbber-small.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';

var gFeedList = {

    get tree gFeedList_tree() {
        delete this.tree;
        return this.tree = getElement('feed-list');
    },

    items: null,  // All treeitems in the tree.

    _lastSelectedItem: null,

    // If TRUE, prevents the onSelect function from running when
    // "select" event is occurs.
    ignoreSelectEvent: false,

    // Indicates that the tree has been built.
    treeReady: false,


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
     * Returns the given feed in form of nsIBriefFeed. We've got feeds passed around
     * in 3 different forms: nsIBriefFeed's, ID's of feeds, and treeitems. This function
     * allows us to ensure that the argument is of nsIBriefFeed type. It makes it easy
     * for other methods of gFeedList to accept any arguments of any type.
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

        if (!selectedItem || this.ignoreSelectEvent || this._lastSelectedItem == selectedItem)
            return;

        // Clicking the twisty also triggers the select event, although the selection
        // doesn't change. We remember the previous selected item and do nothing when
        // the new selected item is the same.
        this._lastSelectedItem = selectedItem;

        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        var title;

        if (selectedItem.id == 'unread-folder') {
            title = selectedItem.getAttribute('title');
            query.unread = true;
        }
        else if (selectedItem.id == 'starred-folder') {
            title = selectedItem.getAttribute('title');
            query.starred = true;
        }
        else if (selectedItem.id == 'trash-folder') {
            title = selectedItem.getAttribute('title');
            query.deleted = ENTRY_STATE_TRASHED;
        }
        else if (selectedItem.hasAttribute('container')) {
            title = this.selectedFeed.title;
            query.folders = [this.selectedFeed.feedID];
        }
        else if (selectedItem.parentNode.parentNode.id == 'starred-folder') {
            title = this.selectedItem.id;
            query.tags = [this.selectedItem.id];
        }
        else {
            title = this.selectedFeed.title;
            query.feeds = [this.selectedFeed.feedID];
        }

        var view = new FeedView(title, query);
        view.attach();
    },

    // Temporarily selects the target items of right-clicks to highlight
    // it when the context menu is shown.
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
        var row = gFeedList.tree.treeBoxObject.getRowAt(aEvent.clientX, aEvent.clientY);
        if (row != -1) {
            var item = gFeedList.tree.view.getItemAtIndex(row);

            // Detect when folder is collapsed/expanded.
            if (item.hasAttribute('container')) {
                if (item.id != 'starred-folder')
                    gFeedList.refreshFolderTreeitems(item);

                // Folder states must be persisted immediatelly instead of when
                // Brief is closed, because otherwise if the feedlist is rebuilt,
                // the changes will be lost.
                async(gFeedList._persistFolderState, 0, gFeedList);
            }

            // If there is a webpage open in the browser then clicking on
            // the already selected item, should bring back the feed view.
            if (!gFeedView.isActive && item == gFeedList.selectedItem && aEvent.button == 0)
                gFeedView.browser.loadURI(gTemplateURI.spec);
        }
    },


    onKeyUp: function gFeedList_onKeyUp(aEvent) {
        var isContainer = this.selectedItem.hasAttribute('container');
        if (isContainer && aEvent.keyCode == aEvent.DOM_VK_RETURN) {
            if (this.selectedItem.id != 'starred-folder')
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

        var query = new Query();
        query.unread = true;
        query.deleted = ENTRY_STATE_NORMAL;

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
     * @param  aFolders  Either a single folder or an array of folders, in the form of
     *                   nsIBriefFeed object, feedID string, or treeitem XULElement.
     */
    refreshFolderTreeitems: function gFeedList_refreshFolderTreeitems(aFolders) {
        if (!this.treeReady)
            return;

        var folders = (aFolders.splice) ? aFolders : [aFolders];

        for (let i = 0; i < folders.length; i++) {
            let folder = this.getBriefFeed(folders[i]);
            let treeitem = getElement(folder.feedID);
            let treecell = treeitem.firstChild.firstChild;

            if (treeitem.getAttribute('open') == 'true') {
                this.removeProperty(treecell, 'unread');
                treecell.setAttribute('label', folder.title);
            }
            else {
                let query = new Query();
                query.deleted = ENTRY_STATE_NORMAL;
                query.folders = [folder.feedID];
                query.unread = true;
                let unreadCount = query.getEntryCount();

                this._setLabel(treecell, folder.title, unreadCount);
            }
        }
    },

    /**
     * Refresh the feed treeitem's label and favicon. Also refreshes folders
     * in the feed's parent chain.
     *
     * @param  aFeeds  Either a single feed or an array of feeds, in the form of
     *                 nsIBriefFeed object, feedID string, or treeitem XULElement.
     */
    refreshFeedTreeitems: function gFeedList_refreshFeedTreeitems(aFeeds) {
        if (!this.treeReady)
            return;

        // Hack: arrays that travelled through XPConnect aren't instanceof Array,
        // so we use the splice method to check if aFeeds is an array.
        var feeds = (aFeeds.splice) ? aFeeds : [aFeeds];

        for (let i = 0; i < feeds.length; i++) {
            let feed = this.getBriefFeed(feeds[i]);
            let treeitem = getElement(feed.feedID);
            let treecell = treeitem.firstChild.firstChild;

            // Update the label.
            let query = new Query();
            query.deleted = ENTRY_STATE_NORMAL;
            query.feeds = [feed.feedID];
            query.unread = true;
            let unreadCount = query.getEntryCount();
            this._setLabel(treecell, feed.title, unreadCount);

            this._refreshFavicon(feed.feedID);
        }

        // |this.items| is null before the tree finishes building. We don't need to
        // refresh the parent folders then, anyway, because _buildFolderChildren does
        // it itself.
        if (this.items) {
            var folders = this.getFoldersForFeeds(aFeeds);
            this.refreshFolderTreeitems(folders);
        }
    },

    /**
     * Refresh the treeitem of a tag.
     *
     * @param aTags            A tag string or an array of tag strings.
     * @param aPossiblyAdded   Indicates that the tag may not be in the list of tags yet.
     * @param aPossiblyRemoved Indicates that there may be no remaining entries with
     *                         the tag.
     */
    refreshTagTreeitems: function gFeedList_refreshTagTreeitems(aTags, aPossiblyAdded,
                                                                aPossiblyRemoved) {
        if (!this.treeReady)
            return;

        var tags = (aTags.splice) ? aTags : [aTags];

        for (let i = 0; i < tags.length; i++) {
            let tag = tags[i];

            if (aPossiblyAdded) {
                if (this.tags.indexOf(tag) == -1) {
                    this._rebuildTags();
                    break;
                }
            }
            else if (aPossiblyRemoved) {
                let query = new Query();
                query.tags = [tag];
                if (!query.hasMatches()) {
                    this._rebuildTags();
                    if (gFeedView.query.tags && gFeedView.query.tags[0] === tag)
                        this.tree.view.selection.select(0);
                    break;
                }
            }

            // Update the label.
            let query = new Query();
            query.deleted = ENTRY_STATE_NORMAL;
            query.tags = [tag];
            query.unread = true;
            let treecell = getElement(tag).firstChild.firstChild;
            this._setLabel(treecell, tag, query.getEntryCount());
        }
    },

    _setLabel: function gFeedList__setLabel(aTreecell, aName, aUnreadCount) {
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

    _refreshFavicon: function gFeedList__refreshFavicon(aFeedID) {
        var feed = gStorage.getFeed(aFeedID);
        var treeitem = getElement(aFeedID);
        var treecell = treeitem.firstChild.firstChild;

        // Update the favicon.
        if (treeitem.hasAttribute('loading'))
            treecell.setAttribute('src', THROBBER_URL);
        else if (treeitem.hasAttribute('error'))
            treecell.setAttribute('src', ERROR_ICON_URL);
        else if (feed.favicon != 'no-favicon')
            treecell.setAttribute('src', feed.favicon);
        else
            treecell.removeAttribute('src');
    },

    // Rebuilds the feedlist tree.
    rebuild: function gFeedList_rebuild() {
        // Can't build the tree if it is hidden and has no view.
        if (!this.tree.view)
            return;

        this.treeReady = true;

        this.refreshSpecialTreeitem('unread-folder');
        this.refreshSpecialTreeitem('starred-folder');
        this.refreshSpecialTreeitem('trash-folder');

        // Remember selection.
        this.lastSelectedID = this.selectedItem ? this.selectedItem.id : '';

        // Clear the existing tree.
        var topLevelChildren = getElement('top-level-children');
        var lastChild = topLevelChildren.lastChild;
        while (lastChild.id != 'special-folders-separator') {
            topLevelChildren.removeChild(lastChild);
            lastChild = topLevelChildren.lastChild
        }

        this._rebuildTags(true);

        this.feeds = gStorage.getAllFeeds(true);

        // This a helper array used by _buildFolderChildren. As the function recurses,
        // the array stores the <treechildren> elements of all folders in the parent
        // chain of the currently processed folder. This is how it tracks where to
        // append the items.
        this._folderParentChain = [topLevelChildren];

        this._buildFolderChildren(gPrefs.homeFolder);

        this._restoreSelection();

        // Fill the items cache.
        this.items = this.tree.getElementsByTagName('treeitem');
    },

    // Cached document fragments, "bricks" used to build the tree.
    get _containerRow gFeedList__containerRow() {
        delete this._containerRow;

        this._containerRow = document.createDocumentFragment();

        var treeitem = document.createElement('treeitem');
        treeitem.setAttribute('container', 'true');
        treeitem = this._containerRow.appendChild(treeitem);

        var treerow = document.createElement('treerow');
        treerow = treeitem.appendChild(treerow);

        var treecell = document.createElement('treecell');
        treecell = treerow.appendChild(treecell);

        var treechildren = document.createElement('treechildren');
        treechildren = treeitem.appendChild(treechildren);

        return this._containerRow;
    },

    get _flatRow gFeedList__flatRow() {
        delete this._flatRow;

        this._flatRow = document.createDocumentFragment();

        var treeitem = document.createElement('treeitem');
        treeitem = this._flatRow.appendChild(treeitem);

        var treerow = document.createElement('treerow');
        treeitem.appendChild(treerow);

        var treecell = document.createElement('treecell');
        treerow.appendChild(treecell);

        return this._flatRow;
    },

    /**
     * Recursively reads feeds from the database and builds the tree, starting from the
     * given folder.
     *
     * @param aParentFolder feedID of the folder.
     */
    _buildFolderChildren: function gFeedList__buildFolderChildren(aParentFolder) {
        // Iterate over all feeds to find the children.
        for (var i = 0; i < this.feeds.length; i++) {
            var feed = this.feeds[i];

            if (feed.parent != aParentFolder)
                continue;

            var parent = this._folderParentChain[this._folderParentChain.length - 1];

            if (feed.isFolder) {
                var closedFolders = this.tree.getAttribute('closedFolders');
                var isOpen = !closedFolders.match(escape(feed.feedID));

                var fragment = this._containerRow.cloneNode(true);
                var treeitem = fragment.firstChild;
                treeitem.setAttribute('open', isOpen);
                treeitem.setAttribute('id', feed.feedID);

                parent.appendChild(fragment);

                this.refreshFolderTreeitems(treeitem);

                this._folderParentChain.push(treeitem.lastChild);

                this._buildFolderChildren(feed.feedID);
            }
            else {
                var fragment = this._flatRow.cloneNode(true);
                var treeitem = fragment.firstChild;
                treeitem.setAttribute('id', feed.feedID);
                treeitem.setAttribute('url', feed.feedURL);

                var treecell = treeitem.firstChild.firstChild;
                treecell.setAttribute('properties', 'feed-item ');

                parent.appendChild(fragment);

                this.refreshFeedTreeitems(treeitem);
            }
        }
        this._folderParentChain.pop();
    },

    _rebuildTags: function gFeedList__rebuildTags(aDontRestoreSelection) {
        if (!aDontRestoreSelection)
            this.lastSelectedID = this.selectedItem ? this.selectedItem.id : '';

        var starredFolder = getElement('starred-folder');

        // Clear the old tag list.
        starredFolder.removeChild(starredFolder.lastChild);
        var tagsTreechildren = document.createElement('treechildren');
        starredFolder.appendChild(tagsTreechildren);

        // Build the tag list.
        this.tags = gStorage.getAllTags();

        if (this.tags.length)
            starredFolder.setAttribute('container', true);
        else
            starredFolder.removeAttribute('container');

        starredFolder.setAttribute('open', starredFolder.getAttribute('wasOpen'));

        for (let i = 0; i < this.tags.length; i++) {
            let fragment = this._flatRow.cloneNode(true);
            let treeitem = fragment.firstChild;
            treeitem.id = this.tags[i];

            let treecell = treeitem.firstChild.firstChild;
            treecell.setAttribute('properties', 'tag ');

            tagsTreechildren.appendChild(fragment);

            this.refreshTagTreeitems(this.tags[i]);
        }

        if (!aDontRestoreSelection)
            this._restoreSelection()
    },


    _restoreSelection: function gFeedList__restoreSelection() {
        if (!this.lastSelectedID)
            return;

        var itemToSelect = getElement(this.lastSelectedID);
        if (itemToSelect) {
            let index = this.tree.view.getIndexOfItem(itemToSelect);
            this.ignoreSelectEvent = true;
            this.tree.view.selection.select(index);
            this.ignoreSelectEvent = false;
        }
        else {
            this.tree.view.selection.select(0);
        }

        this.lastSelectedID = '';
    },


    observe: function gFeedList_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

        // The Live Bookmarks stored is user's folder of choice were read and the
        // in-database list of feeds was synchronized.
        case 'brief:invalidate-feedlist':
            this.rebuild();

            let deck = getElement('feed-list-deck');
            if (gPrefs.homeFolder)
                deck.selectedIndex = 0;
            else if (deck.selectedIndex == 0)
                showHomeFolderPicker();

            async(gFeedView.refresh, 0, gFeedView);

            break;

        case 'brief:feed-title-changed':
            var feed = gStorage.getFeed(aData);
            if (feed.isFolder)
                this.refreshFolderTreeitems(feed);
            else
                this.refreshFeedTreeitems(feed);
            break;

        case 'brief:feed-updated':
            if (this.treeReady) {
                let item = getElement(aData);
                item.removeAttribute('error');
                item.removeAttribute('loading');
                this._refreshFavicon(aData);
            }
            refreshProgressmeter();
            break;

        case 'brief:feed-loading':
            if (this.treeReady) {
                let item = getElement(aData);
                item.setAttribute('loading', true);
                this._refreshFavicon(aData);
            }
            break;

        // Error occured when downloading or parsing the feed, show error icon.
        case 'brief:feed-error':
            if (this.treeReady) {
                let item = getElement(aData);
                item.removeAttribute('loading');
                item.setAttribute('error', true);
                this._refreshFavicon(aData);
            }
            refreshProgressmeter();
            break;

        case 'brief:feed-update-queued':
            getElement('update-buttons-deck').selectedIndex = 1;

            if (gUpdateService.scheduledFeedsCount > 1) {
                getElement('update-progress').hidden = false;
                refreshProgressmeter();
            }
            break;

        case 'brief:feed-update-canceled':
            var progressmeter = getElement('update-progress');
            progressmeter.hidden = true;
            progressmeter.value = 0;

            for each (feed in gStorage.getAllFeeds(false)) {
                let item = getElement(feed.feedID);
                if (item.hasAttribute('loading')) {
                    item.removeAttribute('loading');
                    this._refreshFavicon(feed.feedID);
                }
            }
            break;

        case 'brief:custom-style-changed':
            gFeedView.browser.loadURI(gTemplateURI.spec);
            break;
        }
    },


    // nsIBriefStorageObserver
    onEntriesAdded: function gFeedList_onEntriesAdded(aEntryList) {
        async(function() {
            this.refreshFeedTreeitems(aEntryList.feedIDs);
            this.refreshSpecialTreeitem('unread-folder');

            if (aEntryList.containsStarred()) {
                this.refreshSpecialTreeitem('starred-folder');
                this.refreshTagTreeitems(aEntryList.tags, true);
            }

        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesUpdated: function gFeedList_onEntriesUpdated(aEntryList) {
        async(function() {
            if (aEntryList.containsUnread()) {
                this.refreshFeedTreeitems(aEntryList.feedIDs);
                this.refreshSpecialTreeitem('unread-folder');
                this.refreshTagTreeitems(aEntryList.tags);
            }

        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesMarkedRead: function gFeedList_onEntriesMarkedRead(aEntryList, aNewState) {
        async(function() {
            this.refreshFeedTreeitems(aEntryList.feedIDs);
            this.refreshSpecialTreeitem('unread-folder');

            if (aEntryList.containsStarred()) {
                this.refreshSpecialTreeitem('starred-folder');
                this.refreshTagTreeitems(aEntryList.tags);
            }

            if (aEntryList.containsTrashed())
                this.refreshSpecialTreeitem('trash-folder');

        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesStarred: function gFeedList_onEntriesStarred(aEntryList, aNewState) {
        async(function() {
            if (aEntryList.containsUnread())
                this.refreshSpecialTreeitem('starred-folder');

        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesTagged: function gFeedList_onEntriesTagged(aEntryList, aNewState, aTag) {
        async(function() {
            this.refreshTagTreeitems(aTag, aNewState, !aNewState);

        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesDeleted: function gFeedList_onEntriesDeleted(aEntryList, aNewState) {
        async(function() {
            if (aEntryList.containsUnread()) {
                this.refreshFeedTreeitems(aEntryList.feedIDs);
                this.refreshSpecialTreeitem('unread-folder');

                this.refreshSpecialTreeitem('trash-folder');

                if (aEntryList.containsStarred())
                    this.refreshSpecialTreeitem('starred-folder');
            }

            var entriesRestored = (aNewState == ENTRY_STATE_NORMAL);
            this.refreshTagTreeitems(aEntryList.tags, entriesRestored, !entriesRestored);

        }, 0, this)
    },


    _persistFolderState: function gFeedList_persistFolderState() {
        // Persist the folders open/closed state.
        var closedFolders = '';
        for (var i = 0; i < this.items.length; i++) {
            var item = this.items[i];
            if (item.hasAttribute('container') && item.getAttribute('open') == 'false')
                closedFolders += item.id;
        }
        gFeedList.tree.setAttribute('closedFolders', escape(closedFolders));

        var starredFolder = getElement('starred-folder');
        starredFolder.setAttribute('wasOpen', starredFolder.getAttribute('open'));
    },


    setProperty: function gFeedList_setProperty(aItem, aProperty) {
        var properties = aItem.getAttribute('properties');
        if (!properties.match(aProperty + ' '))
            aItem.setAttribute('properties', properties + aProperty + ' ');
    },

    removeProperty: function gFeedList_removeProperty(aItem, aProperty) {
        var properties = aItem.getAttribute('properties');
        if (properties.match(aProperty)) {
            properties = properties.replace(aProperty + ' ', '');
            aItem.setAttribute('properties', properties);
        }
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
    get targetIsFolder()        this.targetItem.hasAttribute('container')
                                && !this.targetIsStarredFolder,
    get targetIsTag()           this.targetItem.parentNode.parentNode.id == 'starred-folder',
    get targetIsUnreadFolder()  this.targetItem.id == 'unread-folder',
    get targetIsStarredFolder() this.targetItem.id == 'starred-folder',
    get targetIsTrashFolder()   this.targetItem.id == 'trash-folder',
    get targetIsSpecialFolder() this.targetIsUnreadFolder || this.targetIsStarredFolder
                                || this.targetIsTrashFolder,


    init: function gContextMenu_init(aTargetItem) {
        this.targetItem = aTargetItem;

        getElement('ctx-mark-feed-read').hidden = !this.targetIsFeed;
        getElement('ctx-mark-folder-read').hidden = !this.targetIsFolder &&
                                                    !this.targetIsSpecialFolder;
        getElement('ctx-mark-tag-read').hidden = !this.targetIsTag;
        getElement('ctx-update-feed').hidden = !this.targetIsFeed;
        getElement('ctx-update-folder').hidden = !this.targetIsFolder;

        var openWebsite = getElement('ctx-open-website');
        openWebsite.hidden = !this.targetIsFeed;
        if (this.targetIsFeed)
            openWebsite.disabled = !gStorage.getFeed(this.targetItem.id).websiteURL;

        getElement('ctx-properties-separator').hidden = !this.targetIsFeed;
        getElement('ctx-feed-properties').hidden = !this.targetIsFeed;

        // Menuitems related to deleting feeds and folders.
        var dangerousSeparator = getElement('ctx-dangerous-cmds-separator');
        dangerousSeparator.hidden = this.targetIsStarredFolder;
        getElement('ctx-delete-feed').hidden = !this.targetIsFeed;
        getElement('ctx-delete-folder').hidden = !this.targetIsFolder;
        getElement('ctx-delete-tag').hidden = !this.targetIsTag;

        // Menuitems related to emptying feeds and folders.
        getElement('ctx-empty-feed').hidden = !this.targetIsFeed;
        getElement('ctx-empty-folder').hidden = !(this.targetIsFolder || this.targetIsUnreadFolder);
        getElement('ctx-restore-trashed').hidden = !this.targetIsTrashFolder;
        getElement('ctx-empty-trash').hidden = !this.targetIsTrashFolder;

    },


    markFeedRead: function gContextMenu_markFeedRead() {
        var query = new Query();
        query.feeds = [this.targetID];
        query.deleted = ENTRY_STATE_NORMAL;
        query.markEntriesRead(true);
    },


    markFolderRead: function gContextMenu_markFolderRead() {
        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;

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


    markTagRead: function gContextMenu_markTagRead() {
        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        query.tags = [this.targetItem.id];
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
        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        query.feeds = [this.targetID];
        query.unstarred = true;
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },


    emptyFolder: function gContextMenu_emptyFolder() {
        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
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


    deleteTag: function gContextMenu_deleteTag() {
        var ioService = Cc['@mozilla.org/network/io-service;1'].
                            getService(Ci.nsIIOService);
        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var tag = this.targetItem.id;

        var bundle = getElement('main-bundle');
        var dialogTitle = bundle.getString('confirmTagDeletionTitle');
        var dialogText = bundle.getFormattedString('confirmTagDeletionText', [tag]);

        var weHaveAGo = promptService.confirm(window, dialogTitle, dialogText);

        if (weHaveAGo) {
            var query = new Query();
            query.tags = [tag];
            var urls = query.getProperty('entryURL', true).
                             map(function(e) e.entryURL);

            for (let i = 0; i < urls.length; i++) {
                let uri = ioService.newURI(urls[i], null, null);
                PlacesUtils.tagging.untagURI(uri, [tag]);
            }
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
