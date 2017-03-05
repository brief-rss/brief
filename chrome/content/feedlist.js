const THROBBER_URL = 'chrome://brief/skin/throbber.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';



function TreeView(aElementOrId) {
    this.root = this._resolveElement(aElementOrId, "");
    this.prefix = this.root.classList.contains('unprefixed') ? "" : this.root.id + "__";
    this.folderTemplate = this.root.querySelector('template.tree-folder');
    this.itemTemplate = this.root.querySelector('template.tree-item');
    this._selectedElement = null;
    Array.forEach(this.root.children, node => {
        if(node.nodeName !== 'template')
            node.addEventListener('click', this);
    })
}

TreeView.prototype = {
    get selectedItem() {
        return this._selectedElement;
    },
    set selectedItem(aElementOrId) {
        if(this._selectedElement !== null) {
            this._selectedElement.classList.remove('selected');
            this._selectedElement = null;
        }
        if(aElementOrId !== null) {
            this._selectedElement = this._resolveElement(aElementOrId);
            this._selectedElement.classList.add('selected');
        }
        let event = new Event("change", {bubbles: true, cancelable: false});
        this.root.dispatchEvent(event);

        return aElementOrId;
    },

    update: function TreeView_update(aModel) {
        let knownIds = new Set(aModel.map(node => node.id));
        let next = this.root.children.item(0);
        for (let node of aModel) {
            // Skip or delete everything that's not to stay
            while(next !== null && (!next.hasOwnProperty('id') || !knownIds.has(next.id))) {
                let current = next;
                next = next.nextSibling;
                if(current.nodeName !== 'template')
                    current.parentNode.removeChild(current);
            }
            // Find or create the element
            let element = this._resolveElement(this._mangleId(node.id));
            if(element === null) {
                let template = this.itemTemplate.content;
                if(!template.hasChildNodes()) // XXX: hack for <template> not working in XUL
                    template = this.itemTemplate;
                template = template.querySelector('tree-item');
                element = document.importNode(template, true);
                element.addEventListener('click', this);
            }
            this.updateElement(element, node);
            if(next === null) {
                this.root.appendChild(element);
            } else if(element !== next) {
                next.before(element);
            } else {
                next = next.nextSibling;
            }
        }
    },
    updateElement: function TreeView_updateElement(aElement, aModel) {
        const {id, title, icon, unreadCount, children} = aModel;
        const isFolder = children !== undefined;
        let element = this._resolveElement(aElement);
        if(isFolder !== (element.nodeName === "tree-folder")) {
            let template = isFolder ? this.folderTemplate : this.itemTemplate;
            let newElement = document.importNode(template.content, true);
            element.replaceWith(newElement);
            element = newElement;
        }
        let row = isFolder ? element.querySelector('tree-folder-header') : element;
        if(id !== undefined) {
            row.id = this.root.id + '__' + this._mangleId(id);
            row.dataset.id = id;
        }
        if(title !== undefined)
            row.querySelector('.title').textContent = title;
        if(icon !== undefined)
            row.querySelector('.icon').src = icon;
        if(unreadCount !== undefined)
            row.querySelector('.unread-count').textContent = unreadCount;
        if(unreadCount > 0) {
            row.classList.add('unread');
        } else {
            row.classList.remove('unread');
        }
    },

    get hidden() {
        return this.root.hidden;
    },
    set hidden(aHidden) {
        return this.root.hidden = aHidden;
    },

    _resolveElement: function TreeView__resolveElement(aElementOrId, aPrefix) {
        let prefix = (aPrefix === undefined) ? this.prefix : aPrefix;
        if(typeof aElementOrId === "string") {
            return document.getElementById(prefix + this._mangleId(aElementOrId));
        } else {
            return aElementOrId;
        }
    },
    // HTML5 id must not contain spaces
    // XXX: XHTML5?!!
    _mangleId: function(aId) {
        return aId.replace('_', '__').replace(' ', '_');
    },

    handleEvent: function TreeView__handleEvent(aEvent) {
        if(aEvent.type !== 'click')
            return;
        this.selectedItem = aEvent.currentTarget;
    },
};

let ViewList = {
    get tree() {
        delete this.tree;
        return this.tree = new TreeView('view-list');
    },

    get selectedItem() {
        return this.tree.selectedItem;
    },

    set selectedItem(aItem) {
        this.tree.selectedItem = aItem;
        return aItem;
    },

    init: function ViewList_init() {
        this.deselect();

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
        this.tree.selectedItem = null;
    },

    onSelect: function ViewList_onSelect(aEvent) {
        if (!this.selectedItem)
            return;

        TagList.deselect();
        FeedList.deselect();

        if (this.selectedItem.id == 'starred-folder') {
            Storage.getAllTags().then(tags => {
                if (tags.length)
                    TagList.show();
            })
        }

        let title = this.selectedItem.getElementsByClassName('title')[0].textContent;
        let query = this.getQueryForView(this.selectedItem.id);
        gCurrentView = new FeedView(title, query);
    },

    refreshItem: function* ViewList_refreshItem(aItemID) {
        let query = this.getQueryForView(aItemID);
        query.read = false;

        let unreadCount = yield query.getEntryCount();

        this.tree.updateElement(aItemID, {unreadCount});
    }.task()
}


let TagList = {

    ready: false,

    tags: null,

    get selectedItem() {
        return this.tree.selectedItem;
    },

    get tree() {
        delete this.tree;
        return this.tree = new TreeView('tag-list');
    },

    show: function TagList_show() {
        if (!this.ready)
            this._rebuild();

        if (this.tree.hidden) {
            this.tree.hidden = false;
            getElement('tag-list-splitter').hidden = false;
        }
    },

    hide: function TagList_hide() {
        if (!this.tree.hidden) {
            this.tree.hidden = true;
            getElement('tag-list-splitter').hidden = true;
        }
    },

    deselect: function TagList_deselect() {
        this.tree.selectedItem = null;
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
            tags: [this.selectedItem.dataset.id]
        })

        gCurrentView = new FeedView(this.selectedItem.dataset.id, query);
    },

    /**
     * Refreshes tag listitems.
     *
     * @param aTags            An array of tag strings.
     * @param aPossiblyAdded   Indicates that the tag may not be in the list of tags yet.
     * @param aPossiblyRemoved Indicates that there may be no remaining entries with
     *                         the tag.
     */
    refreshTags: function* TagList_refreshTags(aTags, aPossiblyAdded, aPossiblyRemoved) {
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
                let tagExists = yield new Query({ tags: [tag] }).hasMatches();
                if (tagExists) {
                    this._refreshLabel(tag);
                }
                else {
                    this._rebuild();
                    if (gCurrentView.query.tags && gCurrentView.query.tags[0] === tag)
                        ViewList.selectedItem = getElement('starred-folder');
                }
            }
            else {
                this._refreshLabel(tag);
            }
        }
    }.task(),

    _rebuild: function* TagList__rebuild() {
        this.tags = yield Storage.getAllTags();

        let model = this.tags.map(tag => ( {id: tag, title: tag, unreadCount: 0} ));

        this.tree.update(model);

        for (let tagName of this.tags) {
            yield this._refreshLabel(tagName);
        }

        this.ready = true;
    }.task(),

    _refreshLabel: function* TagList__refreshLabel(aTagName) {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            tags: [aTagName],
            read: false
        })
        let unreadCount = yield query.getEntryCount();
        this.tree.updateElement(aTagName, {unreadCount});
    }.task()

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
        aFolders.map(Storage.getFeed).forEach(this._refreshLabel, this);
    },

    /**
     * Refresh the feed treeitem's label and favicon. Also refreshes folders
     * in the feed's parent chain.
     *
     * @param aFeeds
     *        An array of feed IDs.
     */
    refreshFeedTreeitems: function FeedList_refreshFeedTreeitems(aFeeds) {
        for (let feed of aFeeds.map(Storage.getFeed)) {
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

    _refreshLabel: function* FeedList__refreshLabel(aFeed) {
        let query = new Query({
            deleted: Storage.ENTRY_STATE_NORMAL,
            folders: aFeed.isFolder ? [aFeed.feedID] : undefined,
            feeds: aFeed.isFolder ? undefined : [aFeed.feedID],
            read: false
        })

        let unreadCount = yield query.getEntryCount()
        let treeitem = getElement(aFeed.feedID);

        treeitem.setAttribute('title', aFeed.title);
        treeitem.setAttribute('unreadcount', unreadCount);

        if (unreadCount > 0)
            treeitem.classList.add('unread');
        else
            treeitem.classList.remove('unread');
    }.task(),

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
                ViewList.refreshItem('all-items-folder');
                ViewList.refreshItem('today-folder');
                ViewList.refreshItem('starred-folder');
                if (this.expectRemovalInvalidate) {
                    /* Removal is performed manually to avoid full rebuild,
                     * only unread counts need to be updated */
                    FeedList.expectRemovalInvalidate = false;
                    // TODO: avoid refreshing non-parent folders
                    Storage.getAllFeeds(true).forEach(this._refreshLabel, this);
                }
                else {
                    this.persistFolderState();
                    this.rebuild();

                    wait().then(() => gCurrentView.refresh());
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

            case 'brief:feed-updated': {
                let item = getElement(aData);
                item.removeAttribute('error');
                item.removeAttribute('loading');
                this._refreshFavicon(aData);
                refreshProgressmeter();
                break;
            }

            case 'brief:feed-loading': {
                let item = getElement(aData);
                item.setAttribute('loading', true);
                this._refreshFavicon(aData);
                break;
            }

            case 'brief:feed-error': {
                let item = getElement(aData);
                item.setAttribute('error', true);
                this._refreshFavicon(aData);
                break;
            }

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
        this.refreshFeedTreeitems(aEntryList.feeds);
        ViewList.refreshItem('all-items-folder');
        ViewList.refreshItem('today-folder');
    },

    onEntriesUpdated: function FeedList_onEntriesUpdated(aEntryList) {
        this.refreshFeedTreeitems(aEntryList.feeds);
        ViewList.refreshItem('all-items-folder');
        ViewList.refreshItem('today-folder');
        TagList.refreshTags(aEntryList.tags);
    },

    onEntriesMarkedRead: function FeedList_onEntriesMarkedRead(aEntryList, aNewState) {
        wait(250).then(() =>
            FeedList.refreshFeedTreeitems(aEntryList.feeds)
        )

        wait(500).then(() => {
            ViewList.refreshItem('all-items-folder');
            ViewList.refreshItem('today-folder');
            ViewList.refreshItem('starred-folder');
            TagList.refreshTags(aEntryList.tags);
        })
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
        wait(250).then(() =>
            FeedList.refreshFeedTreeitems(aEntryList.feeds)
        )

        wait(500).then(() => {
            ViewList.refreshItem('all-items-folder');
            ViewList.refreshItem('today-folder');
            ViewList.refreshItem('starred-folder');
        })

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

    get targetIsAllItemsFolder() { return this.targetItem.id == 'all-items-folder' },
    get targetIsTodayFolder()   { return this.targetItem.id == 'today-folder' },
    get targetIsStarredFolder()  { return this.targetItem.id == 'starred-folder' },
    get targetIsTrashFolder()    { return this.targetItem.id == 'trash-folder' },

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

    emptyTodayFolder: function ViewListContextMenu_emptyTodayFolder() {
        let query = ViewList.getQueryForView('today-folder');
        query.starred = false;
        query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
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

    deleteTag: function* TagListContextMenu_deleteTag() {
        let taggingService = Cc['@mozilla.org/browser/tagging-service;1'].
                             getService(Ci.nsITaggingService);

        let tag = TagList.selectedItem.id;

        let dialogTitle = STRINGS.GetStringFromName('confirmTagDeletionTitle');
        let dialogText = STRINGS.formatStringFromName('confirmTagDeletionText', [tag], 1);

        if (!Services.prompt.confirm(window, dialogTitle, dialogText))
            return;

        let urls = yield new Query({ tags: [tag] }).getProperty('entryURL', true);
        for (let url of urls) {
            try {
                var uri = NetUtil.newURI(url, null, null);
            }
            catch (ex) {
                return;
            }
            taggingService.untagURI(uri, [tag]);
        }
    }.task()

}


let FeedContextMenu = {

    init: function FeedContextMenu_init() {
        this.targetFeed = Storage.getFeed(FeedList.selectedItem.id);

        getElement('ctx-open-website').disabled = !this.targetFeed.websiteURL;
    },

    markFeedRead: function FeedContextMenu_markFeedRead() {
        let query = new Query({
            feeds: [this.targetFeed.feedID],
            deleted: Storage.ENTRY_STATE_NORMAL
        })
        query.markEntriesRead(true);
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

        let title = STRINGS.GetStringFromName('confirmFolderDeletionTitle');
        let text = STRINGS.formatStringFromName('confirmFolderDeletionText', [feed.title], 1);

        if (Services.prompt.confirm(window, title, text)) {
            FeedList.removeItem(item);
            FeedList.expectRemovalInvalidate = true;

            Components.utils.import('resource://gre/modules/PlacesUtils.jsm');

            let txn = new PlacesRemoveItemTransaction(Number(feed.bookmarkID));
            PlacesUtils.transactionManager.doTransaction(txn);
        }
    }

}
