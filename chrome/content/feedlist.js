const THROBBER_URL = 'chrome://brief/skin/throbber.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';

let ViewList = {

    get richlistbox() {
        delete this.richlistbox;
        return this.richlistbox = getElement('view-list');
    },

    get selectedItem() {
        return this.richlistbox.selectedItem;
    },

    set selectedItem(aItem) {
        this.richlistbox.selectedItem = aItem;
        return aItem;
    },

    init: function ViewList_init() {
        // The select event was suppressed because richlistbox initiates selection
        // during document load, before the feed view browser is ready.
        this.richlistbox.suppressOnSelect = false;
        this.deselect()

        this.refreshItem('all-items-folder');
        this.refreshItem('today-folder');
        this.refreshItem('starred-folder');
    },

    getQueryForView: function(aViewID) {
        switch (aViewID) {
            case 'all-items-folder':
                var constraints = {
                    includeFeedsExcludedFromGlobalViews: false,
                    deleted: Storage.ENTRY_STATE_NORMAL
                };
                break;

            case 'today-folder':
                constraints = {
                    startDate: new Date().setHours(0, 0, 0, 0),
                    includeFeedsExcludedFromGlobalViews: false,
                    deleted: Storage.ENTRY_STATE_NORMAL,
                }
                break;

            case 'starred-folder':
                constraints = {
                    deleted: Storage.ENTRY_STATE_NORMAL,
                    starred: true
                }
                break;

            case 'trash-folder':
                constraints = { deleted: Storage.ENTRY_STATE_TRASHED };
        }

        return new Query(constraints);
    },

    deselect: function ViewList_deselect() {
        this.richlistbox.selectedIndex = -1;
    },

    onSelect: function ViewList_onSelect(aEvent) {
        if (!this.selectedItem)
            return;

        TagList.deselect();
        FeedList.deselect();

        if (this.selectedItem.id == 'starred-folder') {
            Storage.getAllTags(function(tags) {
                if (tags.length)
                    TagList.show();
            })
        }

        let title = this.selectedItem.getElementsByClassName('view-title')[0].value;
        let query = this.getQueryForView(this.selectedItem.id);
        gCurrentView = new FeedView(title, query);
    },

    refreshItem: function ViewList_refreshItem(aItemID) {
        let query = this.getQueryForView(aItemID);
        query.read = false;

        let unreadCount = yield query.getEntryCount(ViewList_refreshItem.resume);

        let element = getElement(aItemID);
        element.lastChild.value = unreadCount;

        if (unreadCount > 0)
            element.classList.add('unread');
        else
            element.classList.remove('unread');
    }.gen()

}


let TagList = {

    ready: false,

    tags: null,

    get selectedItem() {
        return this._listbox.selectedItem;
    },

    get _listbox() {
        delete this._listbox;
        return this._listbox = getElement('tag-list');
    },

    show: function TagList_show() {
        if (!this.ready)
            this._rebuild();

        if (this._listbox.hidden) {
            this._listbox.hidden = false;
            getElement('tag-list-splitter').hidden = false;
        }
    },

    hide: function TagList_hide() {
        if (!this._listbox.hidden) {
            this._listbox.hidden = true;
            getElement('tag-list-splitter').hidden = true;
        }
    },

    deselect: function TagList_deselect() {
        this._listbox.selectedIndex = -1;
    },

    onSelect: function TagList_onSelect(aEvent) {
        if (!this.selectedItem) {
            this.hide();
            return;
        }

        ViewList.deselect();
        FeedList.deselect();

        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            tags: [this.selectedItem.id]
        })

        gCurrentView = new FeedView(this.selectedItem.id, query);
    },

    /**
     * Refreshes tag listitems.
     *
     * @param aTags            An array of tag strings.
     * @param aPossiblyAdded   Indicates that the tag may not be in the list of tags yet.
     * @param aPossiblyRemoved Indicates that there may be no remaining entries with
     *                         the tag.
     */
    refreshTags: function TagList_refreshTags(aTags, aPossiblyAdded, aPossiblyRemoved) {
        if (!this.ready)
            return;

        for (let tag of aTags) {
            if (aPossiblyAdded) {
                if (this.tags.indexOf(tag) == -1)
                    this._rebuild();
                else
                    this._refreshLabel(tag);
            }
            else if (aPossiblyRemoved) {
                let query = new Query({
                    tags: [tag]
                })

                query.hasMatches(function(hasMatches) {
                    if (hasMatches) {
                        this._refreshLabel(tag);
                    }
                    else {
                        this._rebuild();
                        if (gCurrentView.query.tags && gCurrentView.query.tags[0] === tag)
                            ViewList.selectedItem = getElement('starred-folder');
                    }
                }.bind(this))
            }
            else {
                this._refreshLabel(tag);
            }
        }
    },

    _rebuild: function TagList__rebuild() {
        while (this._listbox.hasChildNodes())
            this._listbox.removeChild(this._listbox.lastChild);

        this.tags = yield Storage.getAllTags(TagList__rebuild.resume);

        for (let tagName of this.tags) {
            let item = document.createElement('listitem');
            item.id = tagName;
            item.className = 'listitem-iconic tag-list-item';
            item.setAttribute('label', tagName);
            this._listbox.appendChild(item);

            let cell = document.getAnonymousElementByAttribute(item, 'class', 'listcell-iconic');

            let unreadCountLabel = document.createElement('label');
            unreadCountLabel.className = 'unread-count';
            item.unreadCountLabel = unreadCountLabel;
            cell.appendChild(unreadCountLabel);

            this._refreshLabel(tagName);
        }

        this.ready = true;
    }.gen(),

    _refreshLabel: function TagList__refreshLabel(aTagName) {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            tags: [aTagName],
            read: false
        })

        query.getEntryCount(function(unreadCount) {
            let listitem = getElement(aTagName);

            listitem.unreadCountLabel.value = unreadCount;

            if (unreadCount > 0)
                listitem.classList.add('unread');
            else
                listitem.classList.remove('unread');
        })
    }

}


let FeedList = {

    get tree() {
        delete this.tree;
        return this.tree = getElement('feed-list');
    },

    get selectedItem() {
        return this.tree.selectedItem;
    },

    get selectedFeed() {
        return this.selectedItem ? Storage.getFeed(this.selectedItem.id) : null;
    },

    deselect: function FeedList_deselect() {
        this.tree.selectedItem = null;
    },

    onSelect: function FeedList_onSelect(aEvent) {
        if (!this.selectedItem)
            return;

        ViewList.deselect();
        TagList.deselect();

        let query = new Query({ deleted: Storage.ENTRY_STATE_NORMAL });

        if (this.selectedFeed.isFolder)
            query.folders = [this.selectedFeed.feedID];
        else
            query.feeds = [this.selectedFeed.feedID];

        gCurrentView = new FeedView(this.selectedFeed.title, query);
    },

    /**
     * Refresh the folder's label.
     *
     * @param aFolders
     *        An array of feed IDs.
     */
    refreshFolderTreeitems: function FeedList_refreshFolderTreeitems(aFolders) {
        aFolders.map(function(f) Storage.getFeed(f))
                .forEach(this._refreshLabel, this);
    },

    /**
     * Refresh the feed treeitem's label and favicon. Also refreshes folders
     * in the feed's parent chain.
     *
     * @param aFeeds
     *        An array of feed IDs.
     */
    refreshFeedTreeitems: function FeedList_refreshFeedTreeitems(aFeeds) {
        let feeds = aFeeds.map(function(f) Storage.getFeed(f));
        for (let feed of feeds) {
            this._refreshLabel(feed);
            this._refreshFavicon(feed.feedID);

            // Build an array of IDs of folders in the the parent chains of
            // the given feeds.
            let folders = [];
            let parentID = feed.parent;

            while (parentID != PrefCache.homeFolder) {
                if (folders.indexOf(parentID) == -1)
                    folders.push(parentID);
                parentID = Storage.getFeed(parentID).parent;
            }

            this.refreshFolderTreeitems(folders);
        }
    },

    _refreshLabel: function FeedList__refreshLabel(aFeed) {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            folders: aFeed.isFolder ? [aFeed.feedID] : undefined,
            feeds: aFeed.isFolder ? undefined : [aFeed.feedID],
            read: false
        })

        query.getEntryCount(function(unreadCount) {
            let treeitem = getElement(aFeed.feedID);

            treeitem.setAttribute('title', aFeed.title);
            treeitem.setAttribute('unreadcount', unreadCount);

            if (unreadCount > 0)
                treeitem.classList.add('unread');
            else
                treeitem.classList.remove('unread');
        })
    },

    _refreshFavicon: function FeedList__refreshFavicon(aFeedID) {
        let feed = Storage.getFeed(aFeedID);
        let treeitem = getElement(aFeedID);

        let icon = '';
        if (treeitem.hasAttribute('loading'))
            icon = THROBBER_URL;
        else if (treeitem.hasAttribute('error'))
            icon = ERROR_ICON_URL;
        else if (PrefCache.showFavicons && feed.favicon && feed.favicon != 'no-favicon')
            icon = feed.favicon;

        treeitem.setAttribute('icon', icon);
    },

    rebuild: function FeedList_rebuild() {
        this.lastSelectedID = this.selectedItem ? this.selectedItem.id : '';

        // Clear the existing tree.
        while (this.tree.hasChildNodes())
            this.tree.removeChild(this.tree.lastChild);

        this.feeds = Storage.getAllFeeds(true);

        // This a helper array used by _buildFolderChildren. As the function recurses,
        // the array stores folders in the parent chain of the currently processed folder.
        // This is how it tracks where to append the items.
        this._folderParentChain = [this.tree];

        this._buildFolderChildren(PrefCache.homeFolder);

        if (this.lastSelectedID) {
            let prevSelectedItem = getElement(this.lastSelectedID);
            if (prevSelectedItem) {
                this.tree.suppressOnSelect = true;
                this.tree.selectedItem = prevSelectedItem;
                this.tree.suppressOnSelect = false;
            }
            else {
                ViewList.selectedItem = getElement('all-items-folder');
            }

            this.lastSelectedID = '';
        }
    },

    /**
     * Recursively reads feeds from the database and builds the tree, starting from the
     * given folder.
     *
     * @param aParentFolder feedID of the folder.
     */
    _buildFolderChildren: function FeedList__buildFolderChildren(aParentFolder) {
        for (let feed of this.feeds) {
            if (feed.parent != aParentFolder)
                continue;

            let parent = this._folderParentChain[this._folderParentChain.length - 1];

            if (feed.isFolder) {
                let closedFolders = this.tree.getAttribute('closedFolders');
                let isOpen = !closedFolders.match(escape(feed.feedID));

                let folder = document.createElement('richtreefolder');
                folder.id = feed.feedID;
                folder.className = 'feed-folder';
                folder.contextMenu = 'folder-context-menu';
                folder.setAttribute('open', isOpen);

                parent.appendChild(folder);

                this.refreshFolderTreeitems([feed.feedID]);

                this._folderParentChain.push(folder);

                this._buildFolderChildren(feed.feedID);
            }
            else {
                let treeitem = document.createElement('richtreeitem');
                treeitem.id = feed.feedID;
                treeitem.className = 'feed-treeitem';
                treeitem.contextMenu = 'feed-context-menu';
                parent.appendChild(treeitem);

                this._refreshLabel(feed);
                this._refreshFavicon(feed.feedID);
            }
        }

        this._folderParentChain.pop();
    },


    observe: function FeedList_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

            case 'brief:invalidate-feedlist':
                if (this.ignoreInvalidateNotification) {
                    FeedList.ignoreInvalidateNotification = false;
                }
                else {
                    this.persistFolderState();
                    this.rebuild();
                    ViewList.refreshItem('all-items-folder');
                    ViewList.refreshItem('today-folder');
                    ViewList.refreshItem('starred-folder');
                    async(gCurrentView.refresh, 0, gCurrentView);
                }
                break;

            case 'brief:feed-title-changed':
                let feed = Storage.getFeed(aData);
                if (feed.isFolder)
                    this.refreshFolderTreeitems([aData]);
                else
                    this.refreshFeedTreeitems([aData]);
                break;

            case 'brief:feed-favicon-changed':
                this._refreshFavicon(aData)
                break;

            case 'brief:feed-updated':
                let item = getElement(aData);
                item.removeAttribute('error');
                item.removeAttribute('loading');
                this._refreshFavicon(aData);
                refreshProgressmeter();
                break;

            case 'brief:feed-loading':
                item = getElement(aData);
                item.setAttribute('loading', true);
                this._refreshFavicon(aData);
                break;

            case 'brief:feed-error':
                item = getElement(aData);
                item.setAttribute('error', true);
                this._refreshFavicon(aData);
                break;

            case 'brief:feed-update-queued':
                refreshProgressmeter();
                break;

            case 'brief:feed-update-finished':
                refreshProgressmeter(aData);

                if (aData == 'cancelled') {
                    for (let feed of Storage.getAllFeeds()) {
                        let item = getElement(feed.feedID);
                        if (item.hasAttribute('loading')) {
                            item.removeAttribute('loading');
                            this._refreshFavicon(feed.feedID);
                        }
                    }
                }
                break;

            case 'brief:custom-style-changed':
                getTopWindow().gBrowser.getBrowserForDocument(document).reload();
                break;
        }
    },


    onEntriesAdded: function FeedList_onEntriesAdded(aEntryList) {
        this.refreshFeedTreeitems(aEntryList.feedIDs);
        ViewList.refreshItem('all-items-folder');
        ViewList.refreshItem('today-folder');
    },

    onEntriesUpdated: function FeedList_onEntriesUpdated(aEntryList) {
        this.refreshFeedTreeitems(aEntryList.feedIDs);
        ViewList.refreshItem('all-items-folder');
        ViewList.refreshItem('today-folder');
        TagList.refreshTags(aEntryList.tags);
    },

    onEntriesMarkedRead: function FeedList_onEntriesMarkedRead(aEntryList, aNewState) {
        async(function() {
            FeedList.refreshFeedTreeitems(aEntryList.feedIDs);
        }, 250)

        async(function() {
            ViewList.refreshItem('all-items-folder');
            ViewList.refreshItem('today-folder');
            ViewList.refreshItem('starred-folder');
            TagList.refreshTags(aEntryList.tags);
        }, 500)
    },

    onEntriesStarred: function FeedList_onEntriesStarred(aEntryList, aNewState) {
        ViewList.refreshItem('starred-folder');
    },

    onEntriesTagged: function FeedList_onEntriesTagged(aEntryList, aNewState, aTag) {
        if (ViewList.selectedItem && ViewList.selectedItem.id == 'starred-folder')
            TagList.show();

        TagList.refreshTags([aTag], aNewState, !aNewState);
    },

    onEntriesDeleted: function FeedList_onEntriesDeleted(aEntryList, aNewState) {
        async(function() {
            FeedList.refreshFeedTreeitems(aEntryList.feedIDs);
        }, 250)

        async(function() {
            ViewList.refreshItem('all-items-folder');
            ViewList.refreshItem('today-folder');
            ViewList.refreshItem('starred-folder');
        }, 500)

        let entriesRestored = (aNewState == Storage.ENTRY_STATE_NORMAL);
        TagList.refreshTags(aEntryList.tags, entriesRestored, !entriesRestored);
    },


    persistFolderState: function FeedList_persistFolderState() {
        let closedFolders = '';
        for (let folder of this.tree.getElementsByTagName('richtreefolder')) {
            if (folder.getAttribute('open') == 'false')
                closedFolders += folder.id;
        }

        FeedList.tree.setAttribute('closedFolders', escape(closedFolders));
    },

    removeItem: function FeedList_removeItem(aElement) {
        let itemToSelect = null;

        if (this.selectedItem == aElement)
            itemToSelect = aElement.nextSibling || aElement.previousSibling || aElement.parentNode;

        aElement.parentNode.removeChild(aElement);

        if (itemToSelect)
            this.tree.selectedItem = itemToSelect;
    }

}



let ViewListContextMenu = {

    targetItem: null,

    get targetIsAllItemsFolder() this.targetItem.id == 'all-items-folder',
    get targetIsTodayFolder()   this.targetItem.id == 'today-folder',
    get targetIsStarredFolder()  this.targetItem.id == 'starred-folder',
    get targetIsTrashFolder()    this.targetItem.id == 'trash-folder',

    init: function ViewListContextMenu_init() {
        this.targetItem = ViewList.selectedItem;

        getElement('ctx-mark-special-folder-read').hidden = !this.targetIsTodayFolder &&
                                                            !this.targetIsTrashFolder &&
                                                            !this.targetIsStarredFolder &&
                                                            !this.targetIsAllItemsFolder;
        getElement('ctx-mark-tag-read').hidden = !this.targetIsTag;
        getElement('ctx-restore-trashed').hidden = !this.targetIsTrashFolder;
        getElement('ctx-view-list-separator').hidden = !this.targetIsTag &&
                                                       !this.targetIsTrashFolder &&
                                                       !this.targetIsTodayFolder;
        getElement('ctx-delete-tag').hidden = !this.targetIsTag;
        getElement('ctx-empty-today-folder').hidden = !this.targetIsTodayFolder;
        getElement('ctx-empty-trash').hidden = !this.targetIsTrashFolder;
    },

    markFolderRead: function ViewListContextMenu_markFolderRead() {
        ViewList.getQueryForView(this.targetItem.id)
                .markEntriesRead(true);
    },

    restoreTrashed: function ViewListContextMenu_restoreTrashed() {
        ViewList.getQueryForView('trash-folder')
                .deleteEntries(Storage.ENTRY_STATE_NORMAL);
    },

    emptyTodayFolder: function ViewListContextMenu_emptyTodayFolder() {
        let query = ViewList.getQueryForView('today-folder');
        query.starred = false;
        query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
    },

    emptyTrash: function gCurrentViewContextMenu_emptyTrash() {
        ViewList.getQueryForView('trash-folder')
                .deleteEntries(Storage.ENTRY_STATE_DELETED);
    }

}


let TagListContextMenu = {

    markTagRead: function TagListContextMenu_markTagRead() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            tags: [TagList.selectedItem.id]
        })
        query.markEntriesRead(true);
    },

    deleteTag: function TagListContextMenu_deleteTag() {
        let taggingService = Cc['@mozilla.org/browser/tagging-service;1'].
                             getService(Ci.nsITaggingService);

        let tag = TagList.selectedItem.id;

        let bundle = getElement('main-bundle');
        let dialogTitle = bundle.getString('confirmTagDeletionTitle');
        let dialogText = bundle.getFormattedString('confirmTagDeletionText', [tag]);

        if (!Services.prompt.confirm(window, dialogTitle, dialogText))
            return;

        let query = new Query({
            tags: [tag]
        })

        query.getProperty('entryURL', true, function(urls) {
            for (let url of urls) {
                try {
                    var uri = NetUtil.newURI(url, null, null);
                }
                catch (ex) {
                    return;
                }
                taggingService.untagURI(uri, [tag]);
            }
        })
    }

}


let FeedContextMenu = {

    targetItem: null,

    get targetID()   this.targetItem.id,
    get targetFeed() Storage.getFeed(this.targetID),

    init: function FeedContextMenu_init() {
        this.targetItem = FeedList.selectedItem;

        getElement('ctx-open-website').disabled = !this.targetFeed.websiteURL;
    },


    markFeedRead: function FeedContextMenu_markFeedRead() {
        let query = new Query({
            feeds: [this.targetID],
            deleted: Storage.ENTRY_STATE_NORMAL
        })
        query.markEntriesRead(true);
    },


    updateFeed: function FeedContextMenu_updateFeed() {
        FeedUpdateService.updateFeeds([this.targetFeed]);
    },

    openWebsite: function FeedContextMenu_openWebsite() {
        let url = this.targetFeed.websiteURL;
        getTopWindow().gBrowser.loadOneTab(url);
    },


    emptyFeed: function FeedContextMenu_emptyFeed() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            starred: false,
            feeds: [this.targetID]
        })
        query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
    },

    deleteFeed: function FeedContextMenu_deleteFeed() {
        let bundle = getElement('main-bundle');
        let title = bundle.getString('confirmFeedDeletionTitle');
        let text = bundle.getFormattedString('confirmFeedDeletionText', [this.targetFeed.title]);

        if (Services.prompt.confirm(window, title, text)) {
            FeedList.removeItem(this.targetItem);
            FeedList.ignoreInvalidateNotification = true;

            Components.utils.import('resource://gre/modules/PlacesUtils.jsm');

            let txn = new PlacesRemoveItemTransaction(this.targetFeed.bookmarkID);
            PlacesUtils.transactionManager.doTransaction(txn);
        }
    },

    showFeedProperties: function FeedContextMenu_showFeedProperties() {
        openDialog('chrome://brief/content/options/feed-properties.xul', 'FeedProperties',
                   'chrome,titlebar,toolbar,centerscreen,modal', this.targetID);
    }

}

let FolderContextMenu = {

    markFolderRead: function FolderContextMenu_markFolderRead() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            folders: [FeedList.selectedFeed.feedID]
        })
        query.markEntriesRead(true);
    },

    updateFolder: function FolderContextMenu_updateFolder() {
        let feeds = [];
        for (let item of FeedList.selectedItem.getElementsByTagName('richtreeitem'))
            feeds.push(Storage.getFeed(item.id));

        FeedUpdateService.updateFeeds(feeds);
    },

    emptyFolder: function FolderContextMenu_emptyFolder() {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            starred: false,
            folders: [FeedList.selectedFeed.feedID]
        })
        query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
    },

    deleteFolder: function FolderContextMenu_deleteFolder() {
        let item = FeedList.selectedItem;
        let feed = FeedList.selectedFeed;

        let bundle = getElement('main-bundle');
        let title = bundle.getString('confirmFolderDeletionTitle');
        let text = bundle.getFormattedString('confirmFolderDeletionText', [feed.title]);

        if (Services.prompt.confirm(window, title, text)) {
            FeedList.removeItem(item);
            FeedList.ignoreInvalidateNotification = true;

            Components.utils.import('resource://gre/modules/PlacesUtils.jsm');

            let txn = new PlacesRemoveItemTransaction(feed.bookmarkID);
            PlacesUtils.transactionManager.doTransaction(txn);
        }
    }

}
