const THROBBER_URL = 'chrome://brief/skin/throbber.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';

var gViewList = {

    get richlistbox gViewList_richlistbox() {
        delete this.richlistbox;
        return this.richlistbox = getElement('view-list');
    },

    get selectedItem gViewList_selectedItem_get() {
        return this.richlistbox.selectedItem;
    },

    set selectedItem gViewList_selectedItem_set(aItem) {
        this.richlistbox.selectedItem = aItem;
        return aItem;
    },

    init: function gViewList_init() {
        this.refreshItem('unread-folder');
        this.refreshItem('starred-folder');
    },

    deselect: function gViewList_deselect() {
        this.richlistbox.selectedIndex = -1;
    },

    onSelect: function gViewList_onSelect(aEvent) {
        if (!this.selectedItem)
            return;

        gTagList.deselect();
        gFeedList.deselect();

        var title = this.selectedItem.getAttribute('name');
        var query = new Query();

        switch (this.selectedItem.id) {
            case 'all-items-folder':
                query.deleted = ENTRY_STATE_NORMAL;
                break;

            case 'unread-folder':
                query.deleted = ENTRY_STATE_NORMAL;
                query.unread = true;
                var fixedUnread = true;
                break;

            case 'starred-folder':
                query.deleted = ENTRY_STATE_NORMAL;
                query.starred = true;
                var fixedStarred = true;

                if (gTagList.tags.length)
                    gTagList.show();
                break;

            case 'trash-folder':
                query.deleted = ENTRY_STATE_TRASHED;
                break;
        }

        gFeedView = new FeedView(title, query, fixedUnread, fixedStarred);
    },

    // If there is a webpage open in the browser then clicking on
    // the already selected item, should bring back the feed view.
    onClick: function gViewList_onClick(aEvent) {
        // Find the target richlistitem in the event target's parent chain
        var targetItem = aEvent.target;
        while (targetItem) {
            if (targetItem.localName == 'richlistitem')
                break;
            targetItem = targetItem.parentNode;
        }

        if (!gFeedView.active && targetItem && aEvent.button == 0)
            gFeedView.browser.loadURI(gTemplateURI.spec);
    },

    refreshItem: function gViewList_refreshItem(aItemID) {
        var item = getElement(aItemID);

        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        query.unread = true;
        query.starred = (aItemID == 'starred-folder');

        var unreadCount = query.getEntryCount();
        var name = item.getAttribute('name');
        if (unreadCount > 0) {
            name += ' (' + unreadCount +')';
            item.setAttribute('unread', true);
        }
        else {
            item.removeAttribute('unread');
        }

        var label = item.lastChild;
        label.setAttribute('value', name);
    }

}

var gTagList = {

    ready: false,

    get tags gTagList_tags_get() {
        if (!this.__tags)
            this.__tags = gStorage.getAllTags();
        return this.__tags;
    },

    set tags gTagList_tags_set(aTags) {
        this.__tags = aTags;
        return aTags;
    },

    get selectedItem gTagList_selectedItem() {
        return this._listbox.selectedItem;
    },

    get _listbox gTagList__listBox() {
        delete this._listbox;
        return this._listbox = getElement('tag-list');
    },

    show: function gTagList_show() {
        if (!this.ready)
            this._rebuild();

        if (this._listbox.hidden) {
            this._listbox.hidden = false;
            getElement('tag-list-splitter').hidden = false;
        }
    },

    hide: function gTagList_hide() {
        if (!this._listbox.hidden) {
            this._listbox.hidden = true;
            getElement('tag-list-splitter').hidden = true;
        }
    },

    deselect: function gTagList_deselect() {
        this._listbox.selectedIndex = -1;
    },

    onSelect: function gTagList_onSelect(aEvent) {
        if (!this.selectedItem) {
            this.hide();
            return;
        }

        gViewList.deselect();
        gFeedList.deselect();

        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        query.tags = [this.selectedItem.id];

        gFeedView = new FeedView(this.selectedItem.id, query, false, true);
    },

    // If there is a webpage open in the browser then clicking on
    // the already selected item, should bring back the feed view.
    onClick: function gTagList_onClick(aEvent) {
        if (!gFeedView.active && aEvent.target.localName != 'listitem' && aEvent.button == 0)
            gFeedView.browser.loadURI(gTemplateURI.spec);
    },

    /**
     * Refreshes tag listitems.
     *
     * @param aTags            A tag string or an array of tag strings.
     * @param aPossiblyAdded   Indicates that the tag may not be in the list of tags yet.
     * @param aPossiblyRemoved Indicates that there may be no remaining entries with
     *                         the tag.
     */
    refreshTags: function gTagList_refreshTags(aTags, aPossiblyAdded, aPossiblyRemoved) {
        if (!this.ready)
            return;

        var tags = (aTags.splice) ? aTags : [aTags];

        for (let i = 0; i < tags.length; i++) {
            let tag = tags[i];

            if (aPossiblyAdded) {
                if (this.tags.indexOf(tag) == -1) {
                    this._rebuild();
                    break;
                }
            }
            else if (aPossiblyRemoved) {
                let query = new Query();
                query.tags = [tag];
                if (!query.hasMatches()) {
                    this._rebuild();
                    if (gFeedView.query.tags && gFeedView.query.tags[0] === tag)
                        gViewList.selectedItem = getElement('starred-folder');
                    break;
                }
            }

            // Update the label.
            let query = new Query();
            query.deleted = ENTRY_STATE_NORMAL;
            query.tags = [tag];
            query.unread = true;
            this._setLabel(getElement(tag), tag, query.getEntryCount());
        }
    },

    _rebuild: function gTagList__rebuild() {
        while (this._listbox.hasChildNodes())
            this._listbox.removeChild(this._listbox.lastChild);

        this.tags = gStorage.getAllTags();

        for (let i = 0; i < this.tags.length; i++) {
            let item = document.createElement('listitem');
            item.id = this.tags[i];
            item.className = 'tag-list-item';

            this._listbox.appendChild(item);

            let query = new Query();
            query.deleted = ENTRY_STATE_NORMAL;
            query.tags = [this.tags[i]];
            query.unread = true;
            this._setLabel(item, this.tags[i], query.getEntryCount());
        }

        this.ready = true;
    },

    _setLabel: function gTagList__setLabel(aItem, aName, aUnreadCount) {
        var name = aName;
        if (aUnreadCount > 0) {
            name += ' (' + aUnreadCount +')';
            aItem.setAttribute('unread', true);
        }
        else {
            aItem.removeAttribute('unread');
        }
        aItem.setAttribute('label', name);
    }

}

var gFeedList = {

    get tree gFeedList_tree() {
        delete this.tree;
        return this.tree = getElement('feed-list');
    },

    // All treeitems in the tree.
    items: null,

    _lastSelectedItem: null,

    ignoreSelectEvent: false,

    treeReady: false,

    get selectedItem gFeedList_selectedItem() {
        var item = null;
        var currentIndex = this.tree.currentIndex;
        if (currentIndex != -1 && currentIndex < this.tree.view.rowCount)
            item = this.tree.view.getItemAtIndex(currentIndex);
        return item;
    },

    // nsIBriefFeed object of currently selected feed, or null.
    get selectedFeed gFeedList_selectedFeed() {
        if (!this.selectedItem)
            return null;

        var feed = null;
        var feedID = this.selectedItem.id;
        if (feedID)
            feed = gStorage.getFeed(feedID);
        return feed;
    },

    deselect: function gFeedList_deselect() {
        this.tree.view.selection.select(-1);
    },

    onSelect: function gFeedList_onSelect(aEvent) {
        var selectedItem = this.selectedItem;
        if (!selectedItem) {
            this._lastSelectedItem = null;
            return;
        }

        if (this.ignoreSelectEvent || this._lastSelectedItem == selectedItem)
            return;

        gViewList.deselect();
        gTagList.deselect();

        // Clicking the twisty also triggers the select event, although the selection
        // doesn't change. We remember the previous selected item and do nothing when
        // the new selected item is the same.
        this._lastSelectedItem = selectedItem;

        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;

        if (selectedItem.hasAttribute('container'))
            query.folders = [this.selectedFeed.feedID];
        else
            query.feeds = [this.selectedFeed.feedID];

        gFeedView = new FeedView(this.selectedFeed.title, query);
    },


    onClick: function gFeedList_onClick(aEvent) {
        var row = gFeedList.tree.treeBoxObject.getRowAt(aEvent.clientX, aEvent.clientY);
        if (row != -1) {
            var item = gFeedList.tree.view.getItemAtIndex(row);

            // Detect when folder is collapsed/expanded.
            if (item.hasAttribute('container')) {
                // This must be done asynchronously, because this listener was called
                // during capture and the folder hasn't actually been opened or closed yet.
                async(function() gFeedList.refreshFolderTreeitems(item.id));

                // Folder states must be persisted immediatelly instead of when
                // Brief is closed, because otherwise if the feedlist is rebuilt,
                // the changes will be lost.
                async(gFeedList._persistFolderState, 0, gFeedList);
            }

            // If there is a webpage open in the browser then clicking on
            // the already selected item, should bring back the feed view.
            if (!gFeedView.active && item == gFeedList.selectedItem && aEvent.button == 0)
                gFeedView.browser.loadURI(gTemplateURI.spec);
        }
    },


    onKeyUp: function gFeedList_onKeyUp(aEvent) {
        var isContainer = this.selectedItem.hasAttribute('container');
        if (isContainer && aEvent.keyCode == aEvent.DOM_VK_RETURN) {
            if (this.selectedItem.id != 'starred-folder')
                this.refreshFolderTreeitems(this.selectedItem.id);

            async(this._persistFolderState, 0, this);
        }
    },

    // Sets the visibility of context menuitem depending on the target.
    onContextMenuShowing: function gFeedList_onContextMenuShowing(aEvent) {
        var row = this.tree.treeBoxObject.getRowAt(aEvent.clientX, aEvent.clientY);
        if (row == -1) {
            aEvent.preventDefault(); // Target is empty space.
        }
        else {
            let target = this.tree.view.getItemAtIndex(row);
            gFeedListContextMenu.init(target);
        }
    },

    /**
     * Refresh the folder's label.
     *
     * @param  aFolders  A single feedID or an array of feedIDs of a folders.
     */
    refreshFolderTreeitems: function gFeedList_refreshFolderTreeitems(aFolders) {
        if (!this.treeReady)
            return;

        // See refreshFeedTreeitems
        var folders = (aFolders.splice) ? aFolders : [aFolders];

        for (let i = 0; i < folders.length; i++) {
            let folder = gStorage.getFeed(folders[i]);
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
     * @param  aFolders  A single feedID or an array of feedIDs of a feeds.
     */
    refreshFeedTreeitems: function gFeedList_refreshFeedTreeitems(aFeeds) {
        if (!this.treeReady)
            return;

        // Hack: arrays that travelled through XPConnect aren't instanceof Array,
        // so we use the splice method to check if aFeeds is an array.
        var feeds = (aFeeds.splice) ? aFeeds : [aFeeds];

        for (let i = 0; i < feeds.length; i++) {
            let feed = gStorage.getFeed(feeds[i]);
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
            let folders = getFoldersForFeeds(aFeeds);
            this.refreshFolderTreeitems(folders);
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
        else if (gPrefs.showFavicons && feed.favicon != 'no-favicon')
            treecell.setAttribute('src', feed.favicon);
        else
            treecell.removeAttribute('src');
    },

    rebuild: function gFeedList_rebuild() {
        // Can't build the tree if it is hidden and has no view.
        if (!this.tree.view)
            return;

        this.treeReady = true;

        // Remember selection.
        this.lastSelectedID = this.selectedItem ? this.selectedItem.id : '';

        // Clear the existing tree.
        var topLevelChildren = getElement('top-level-children');
        while (topLevelChildren.hasChildNodes())
            topLevelChildren.removeChild(topLevelChildren.lastChild);

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

                this.refreshFolderTreeitems(feed.feedID);

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

                this.refreshFeedTreeitems(feed.feedID);
            }
        }
        this._folderParentChain.pop();
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

            let deck = getElement('sidebar-deck');
            if (gPrefs.homeFolder != -1)
                deck.selectedIndex = 0;
            else if (deck.selectedIndex == 0)
                showFirstRunUI();

            async(gFeedView.refresh, 0, gFeedView);
            break;

        case 'brief:feed-title-changed':
            var feed = gStorage.getFeed(aData);
            if (feed.isFolder)
                this.refreshFolderTreeitems(aData);
            else
                this.refreshFeedTreeitems(aData);
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
                item.setAttribute('error', true);
                this._refreshFavicon(aData);
            }
            break;

        case 'brief:feed-update-queued':
            getElement('update-buttons-deck').selectedIndex = 1;

            if (gUpdateService.scheduledFeedsCount > 1) {
                getElement('update-progress-deck').selectedIndex = 1;
                refreshProgressmeter();
            }
            break;

        case 'brief:feed-update-canceled':
            var progressmeter = getElement('update-progress');
            getElement('update-progress-deck').selectedIndex = 0;
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
            gViewList.refreshItem('unread-folder');

            if (aEntryList.containsStarred()) {
                gViewList.refreshItem('starred-folder');
                gTagList.refreshTags(aEntryList.tags, true);
            }

        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesUpdated: function gFeedList_onEntriesUpdated(aEntryList) {
        async(function() {
            if (aEntryList.containsUnread()) {
                this.refreshFeedTreeitems(aEntryList.feedIDs);
                gViewList.refreshItem('unread-folder');
                gTagList.refreshTags(aEntryList.tags);
            }

        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesMarkedRead: function gFeedList_onEntriesMarkedRead(aEntryList, aNewState) {
        async(function() {
            this.refreshFeedTreeitems(aEntryList.feedIDs);
            gViewList.refreshItem('unread-folder');

            if (aEntryList.containsStarred()) {
                gViewList.refreshItem('starred-folder');
                gTagList.refreshTags(aEntryList.tags);
            }
        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesStarred: function gFeedList_onEntriesStarred(aEntryList, aNewState) {
        async(function() {
            if (aEntryList.containsUnread())
                gViewList.refreshItem('starred-folder');

        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesTagged: function gFeedList_onEntriesTagged(aEntryList, aNewState, aTag) {
        async(function() {
            gTagList.refreshTags(aTag, aNewState, !aNewState);
        }, 0, this)
    },

    // nsIBriefStorageObserver
    onEntriesDeleted: function gFeedList_onEntriesDeleted(aEntryList, aNewState) {
        async(function() {
            if (aEntryList.containsUnread()) {
                this.refreshFeedTreeitems(aEntryList.feedIDs);
                gViewList.refreshItem('unread-folder');

                if (aEntryList.containsStarred())
                    gViewList.refreshItem('starred-folder');
            }

            var entriesRestored = (aNewState == ENTRY_STATE_NORMAL);
            gTagList.refreshTags(aEntryList.tags, entriesRestored, !entriesRestored);

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



var gViewListContextMenu = {

    targetItem: null,

    get targetIsAllItemsFolder() this.targetItem.id == 'all-items-folder',
    get targetIsUnreadFolder()   this.targetItem.id == 'unread-folder',
    get targetIsStarredFolder()  this.targetItem.id == 'starred-folder',
    get targetIsTrashFolder()    this.targetItem.id == 'trash-folder',

    init: function gViewListContextMenu_init(aTargetItem) {
        this.targetItem = aTargetItem;

        getElement('ctx-mark-special-folder-read').hidden = !this.targetIsUnreadFolder &&
                                                            !this.targetIsTrashFolder &&
                                                            !this.targetIsStarredFolder &&
                                                            !this.targetIsAllItemsFolder;
        getElement('ctx-mark-tag-read').hidden = !this.targetIsTag;
        getElement('ctx-restore-trashed').hidden = !this.targetIsTrashFolder;
        getElement('ctx-view-list-separator').hidden = !this.targetIsTag &&
                                                       !this.targetIsTrashFolder &&
                                                       !this.targetIsUnreadFolder;
        getElement('ctx-delete-tag').hidden = !this.targetIsTag;
        getElement('ctx-empty-unread-folder').hidden = !this.targetIsUnreadFolder;
        getElement('ctx-empty-trash').hidden = !this.targetIsTrashFolder;
    },

    markFolderRead: function gViewListContextMenu_markFolderRead() {
        var query = new Query();

        if (this.targetIsUnreadFolder) {
            query.deleted = ENTRY_STATE_NORMAL;
            query.unread = true;
        }
        else if (this.targetIsStarredFolder) {
            query.deleted = ENTRY_STATE_NORMAL;
            query.starred = true;
        }
        else if (this.targetIsTrashFolder) {
            query.deleted = ENTRY_STATE_TRASHED;
        }

        query.markEntriesRead(true);
    },

    restoreTrashed: function gViewListContextMenu_restoreTrashed() {
        var query = new Query();
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_NORMAL);
    },

    emptyUnreadFolder: function gViewListContextMenu_emptyUnreadFolder() {
        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        query.unstarred = true;
        query.unread = true;
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },

    emptyTrash: function gFeedViewContextMenu_emptyTrash() {
        var query = new Query();
        query.deleted = ENTRY_STATE_TRASHED;
        query.deleteEntries(ENTRY_STATE_DELETED);

        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);

        var dialogTitle = gStringBundle.getString('compactPromptTitle');
        var dialogText = gStringBundle.getString('compactPromptText');
        var dialogConfirmLabel = gStringBundle.getString('compactPromptConfirmButton');

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
    }

}


var gTagListContextMenu = {

    targetItem: null,

    markTagRead: function gTagListContextMenu_markTagRead() {
        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        query.tags = [this.targetItem.id];
        query.markEntriesRead(true);
    },

    deleteTag: function gTagListContextMenu_deleteTag() {
        var ioService = Cc['@mozilla.org/network/io-service;1'].
                            getService(Ci.nsIIOService);
        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var tag = this.targetItem.id;

        var dialogTitle = gStringBundle.getString('confirmTagDeletionTitle');
        var dialogText = gStringBundle.getFormattedString('confirmTagDeletionText', [tag]);

        var weHaveAGo = promptService.confirm(window, dialogTitle, dialogText);

        if (weHaveAGo) {
            var query = new Query();
            query.tags = [tag];
            var urls = query.getProperty('entryURL', true).
                             map(function(e) e.entryURL);

            for (let i = 0; i < urls.length; i++) {
                try {
                    var uri = ioService.newURI(urls[i], null, null);
                }
                catch (ex) {
                    continue;
                }
                PlacesUtils.tagging.untagURI(uri, [tag]);
            }
        }
    }

}


var gFeedListContextMenu = {

    targetItem: null,

    get targetID() this.targetItem.id,
    get targetFeed() gStorage.getFeed(this.targetID),

    get targetIsFeed()          this.targetItem.hasAttribute('url'),
    get targetIsFolder()        this.targetItem.hasAttribute('container'),


    init: function gFeedListContextMenu_init(aTargetItem) {
        this.targetItem = aTargetItem;

        getElement('ctx-mark-feed-read').hidden = !this.targetIsFeed;
        getElement('ctx-mark-folder-read').hidden = !this.targetIsFolder;
        getElement('ctx-update-feed').hidden = !this.targetIsFeed;
        getElement('ctx-update-folder').hidden = !this.targetIsFolder;

        var openWebsite = getElement('ctx-open-website');
        openWebsite.hidden = !this.targetIsFeed;
        if (this.targetIsFeed)
            openWebsite.disabled = !gStorage.getFeed(this.targetItem.id).websiteURL;

        getElement('ctx-properties-separator').hidden = !this.targetIsFeed;
        getElement('ctx-feed-properties').hidden = !this.targetIsFeed;

        // Menuitems related to deleting feeds and folders.
        getElement('ctx-delete-feed').hidden = !this.targetIsFeed;
        getElement('ctx-delete-folder').hidden = !this.targetIsFolder;

        // Menuitems related to emptying feeds and folders.
        getElement('ctx-empty-feed').hidden = !this.targetIsFeed;
        getElement('ctx-empty-folder').hidden = !this.targetIsFolder;
    },


    markFeedRead: function gFeedListContextMenu_markFeedRead() {
        var query = new Query();
        query.feeds = [this.targetID];
        query.deleted = ENTRY_STATE_NORMAL;
        query.markEntriesRead(true);
    },


    markFolderRead: function gFeedListContextMenu_markFolderRead() {
        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        query.folders = [this.targetID];
        query.markEntriesRead(true);
    },


    updateFeed: function gFeedListContextMenu_updateFeed() {
        gUpdateService.updateFeeds([this.targetFeed]);
    },


    updateFolder: function gFeedListContextMenu_updateFolder() {
        var items = this.targetItem.getElementsByTagName('treeitem');
        var feeds = [];

        for (let i = 0; i < items.length; i++) {
            if (!items[i].hasAttribute('container'))
                feeds.push(gStorage.getFeed(items[i].id));
        }

        gUpdateService.updateFeeds(feeds);
    },


    openWebsite: function gFeedListContextMenu_openWebsite() {
        var url = this.targetFeed.websiteURL;
        getTopWindow().gBrowser.loadOneTab(url);
    },


    emptyFeed: function gFeedListContextMenu_emptyFeed() {
        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        query.feeds = [this.targetID];
        query.unstarred = true;
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },


    emptyFolder: function gFeedListContextMenu_emptyFolder() {
        var query = new Query();
        query.deleted = ENTRY_STATE_NORMAL;
        query.unstarred = true;
        query.folders = [this.targetID];
        query.deleteEntries(ENTRY_STATE_TRASHED);
    },


    deleteFeed: function gFeedListContextMenu_deleteFeed() {
        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var title = gStringBundle.getString('confirmFeedDeletionTitle');
        var text = gStringBundle.getFormattedString('confirmFeedDeletionText',
                                                   [this.targetFeed.title]);
        var weHaveAGo = promptService.confirm(window, title, text);

        if (weHaveAGo) {
            this._removeTreeitem(this.targetItem);
            this._deleteBookmarks([this.targetFeed]);
        }
    },


    deleteFolder: function gFeedListContextMenu_deleteFolder() {
        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var title = gStringBundle.getString('confirmFolderDeletionTitle');
        var text = gStringBundle.getFormattedString('confirmFolderDeletionText',
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
    _removeTreeitem: function gFeedListContextMenu__removeTreeitem(aTreeitem) {
        var treeview = gFeedList.tree.view;
        var currentIndex = treeview.selection.currentIndex;
        var rowCount = treeview.rowCount;
        var indexToSelect = -1;

        if (gFeedList.selectedItem == aTreeitem) {
            if (currentIndex == rowCount - 1)
                indexToSelect = treeview.getIndexOfItem(aTreeitem.previousSibling);
            else
                indexToSelect = currentIndex;
        }

        aTreeitem.parentNode.removeChild(aTreeitem);

        if (indexToSelect != -1)
            async(treeview.selection.select, 0, treeview.selection, indexToSelect);
    },


    _deleteBookmarks: function gFeedListContextMenu__deleteBookmarks(aFeeds) {
        var transactionsService = Cc['@mozilla.org/browser/placesTransactionsService;1'].
                                  getService(Ci.nsIPlacesTransactionsService);

        var transactions = [];
        for (var i = aFeeds.length - 1; i >= 0; i--)
            transactions.push(transactionsService.removeItem(aFeeds[i].bookmarkID));

        var txn = transactionsService.aggregateTransactions('Remove items', transactions);
        transactionsService.doTransaction(txn);
    },


    showFeedProperties: function gFeedListContextMenu_showFeedProperties() {
        openDialog('chrome://brief/content/options/feed-properties.xul', 'FeedProperties',
                   'chrome,titlebar,toolbar,centerscreen,modal', this.targetID);
    }

}


/**
* Returns an array of IDs of folders in the the parent chains of the given feeds.
*
* @param aFeeds A single feedID or an array of feedIDs of a feeds.
* @returns Array of IDs of folders.
*/
function getFoldersForFeeds(aFeeds) {
   var folders = [];
   var root = gPrefs.homeFolder;

    // See refreshFeedTreeitems
   var feeds = (aFeeds.splice) ? aFeeds : [aFeeds];

   for (let i = 0; i < feeds.length; i++) {
       let feed = gStorage.getFeed(feeds[i]);
       let parentID = feed.parent;
       while (parentID != root) {
           if (folders.indexOf(parentID) == -1)
               folders.push(parentID);
           parentID = gStorage.getFeed(parentID).parent;
       }
   }
   return folders;
}
