const THROBBER_URL = 'chrome://brief/skin/throbber.gif';
const ERROR_ICON_URL = 'chrome://brief/skin/icons/error.png';



function TreeView(aElementOrId) {
    this.root = this._resolveElement(aElementOrId, "");
    this.prefix = this.root.classList.contains('unprefixed') ? "" : this.root.id + "__";
    this.template = this.root.querySelector('template');
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
        let element = (aElementOrId !== null) ? this._resolveElement(aElementOrId) : null;
        if(this._selectedElement === element)
            return;
        if(this._selectedElement !== null) {
            this._selectedElement.classList.remove('selected');
            this._selectedElement = null;
        }
        if(element !== null) {
            element.classList.add('selected');
            this._selectedElement = element;
        }
        let event = new Event("change", {bubbles: true, cancelable: false});
        this.root.dispatchEvent(event);

        return aElementOrId;
    },

    update: function TreeView_update(aModel) {
        this._updateChildren(this.root, aModel);
        this._purgeDeleted();
    },
    _updateChildren: function TreeView__updateChildren(aElement, aModel) {
        let knownIds = new Set(aModel.map(node => node.id));
        let next = aElement.children.item(0);
        for (let node of aModel) {
            // Skip or delete everything that's not to stay
            while(next !== null && (!next.hasOwnProperty('id') || !knownIds.has(next.id))) {
                if(next.nodeName !== 'template' && next.nodeName !== 'tree-folder-header') {
                    if(next.nodeType !== Node.ELEMENT_NODE) {
                        next.parentNode.removeChild(next);
                    } else {
                        next.classList.add('deleted');
                    }
                }
                let current = next;
                next = next.nextSibling;
            }
            // Find or create the element
            let element = this._resolveElement(this._mangleId(node.id));
            if(element === null) {
                let template = this.template;
                // XXX: hack for <template> not working in XUL
                if(template.content.hasChildNodes())
                    template = template.content;
                let selector = (node.children !== undefined) ? 'tree-folder' : 'tree-item';
                template = template.querySelector(selector);
                element = document.importNode(template, true);
                element.addEventListener('click', this);
                if(element.nodeName === 'tree-folder') {
                    element.querySelector('.toggle-collapsed').addEventListener('click', this);
                }
            }
            element.classList.remove('deleted');
            this.updateElement(element, node);
            if(next === null) {
                aElement.appendChild(element);
            } else if(element !== next) {
                next.before(element);
            } else {
                next = next.nextSibling;
            }
        }
    },
    updateElement: function TreeView_updateElement(aElement, aModel) {
        const {id, title, icon, unreadCount, loading, error, collapsed, children} = aModel;
        let element = this._resolveElement(aElement);

        const isFolder = (element.nodeName === "tree-folder");
        console.assert(element.nodeName === 'tree-folder' || children === undefined,
            "item->folder conversion not supported");
        let row = isFolder ? element.querySelector('tree-folder-header') : element;

        if(id !== undefined) {
            element.id = this.root.id + '__' + this._mangleId(id);
            element.dataset.id = id;
        }
        if(title !== undefined)
            row.querySelector('.title').textContent = title;
        if(icon !== undefined)
            row.querySelector('.icon').src = icon;
        if(unreadCount !== undefined) {
            row.querySelector('.unread-count').textContent = unreadCount;
            element.classList.toggle('unread', (unreadCount > 0));
        }
        if(loading !== undefined)
            element.dataset.loading = loading;
        if(error !== undefined)
            element.dataset.error = error;
        if(collapsed !== undefined)
            element.classList.toggle('collapsed', collapsed);
        if(children !== undefined)
            this._updateChildren(element, children);
    },
    _purgeDeleted: function TreeView__purgeDeleted() {
        // Move the selection
        let selection = this.selectedItem;
        if(selection) {
            while(selection.classList.contains('deleted'))
                selection = selection.parentNode;
            if(selection === this.root)
                selection = null;
            this.selectedItem = selection;
        }
        //And then purge
        Array.forEach(this.root.querySelectorAll('tree-item.deleted, tree-folder.deleted'),
            node => node.parentNode.removeChild(node));
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
        aEvent.stopPropagation();
        if(aEvent.currentTarget.classList.contains('toggle-collapsed')) {
            // (un)collapse
            let element = aEvent.currentTarget;
            while(element.nodeName !== 'tree-folder') {
                element = element.parentNode;
            }
            element.classList.toggle('collapsed');
        } else {
            // select
            this.selectedItem = aEvent.currentTarget;
        }
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
        } else {
            TagList.hide();
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
            if(!FeedList.selectedItem && !ViewList.selectedItem)
                ViewList.selectedItem = getElement('all-items-folder')
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
        return this.tree = new TreeView('feed-list');
    },

    get selectedItem() {
        return this.tree.selectedItem;
    },

    get selectedFeed() {
        return this.selectedItem ? Storage.getFeed(this.selectedItem.dataset.id) : null;
    },

    deselect: function FeedList_deselect() {
        this.tree.selectedItem = null;
    },

    onSelect: function FeedList_onSelect(aEvent) {
        if (!this.selectedItem) {
            if(!TagList.selectedItem && !ViewList.selectedItem)
                ViewList.selectedItem = getElement('all-items-folder')
            return;
        }

        ViewList.deselect();
        TagList.deselect();
        TagList.hide();

        let query = new Query({ deleted: Storage.ENTRY_STATE_NORMAL });

        if (this.selectedFeed.isFolder)
            query.folders = [this.selectedFeed.feedID];
        else
            query.feeds = [this.selectedFeed.feedID];

        gCurrentView = new FeedView(this.selectedFeed.title, query);
    },

    /**
     * Refresh the feed treeitem's label and unread counts. Also refreshes folders
     * in the feed's parent chain.
     *
     * @param aFeeds
     *        An array of feed IDs.
     */
    refreshFeedTreeitems: function FeedList_refreshFeedTreeitems(aFeeds) {
        for (let feed of aFeeds.map(Storage.getFeed)) {
            this._refreshLabel(feed);

            // Build an array of IDs of folders in the the parent chains of
            // the given feeds.
            let folders = [];
            let parentID = feed.parent;

            while (parentID != PrefCache.homeFolder) {
                if (folders.indexOf(parentID) == -1)
                    folders.push(parentID);
                parentID = Storage.getFeed(parentID).parent;
            }

            folders.map(Storage.getFeed).forEach(this._refreshLabel, this); // start async
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
        this.tree.updateElement(aFeed.feedID, {title: aFeed.title, unreadCount});
    }.task(),

    _faviconUrl: function FeedList__faviconUrl(aFeed) {
        if (PrefCache.showFavicons && aFeed.favicon && aFeed.favicon != 'no-favicon')
            return aFeed.favicon;
        return "chrome://brief/skin/icons/default-feed-favicon.png";
    },

    rebuild: function FeedList_rebuild() {
        this.feeds = Storage.getAllFeeds(true);

        let model = this._buildFolderChildren(PrefCache.homeFolder);
        this.tree.update(model);

        if(this.tree.selectedItem === null)
            ViewList.selectedItem = getElement('starred-folder'); // tmp for debug
    },

    /**
     * Recursively reads feeds from the database and builds the JSON model of the feed tree,
     * starting from the given folder.
     *
     * @param aParentFolder feedID of the folder.
     */
    _buildFolderChildren: function FeedList__buildFolderChildren(aParentFolder) {
        let nodes = [];
        for (let feed of this.feeds) {
            if (feed.parent != aParentFolder)
                continue;

            let item = {
                id: feed.feedID,
                title: feed.title,
            };


            if (feed.isFolder) {
                let closedFolders = this.tree.root.getAttribute('closedFolders') || "";
                item.collapsed = closedFolders.match(escape(feed.feedID));

                item.children = this._buildFolderChildren(feed.feedID);
            }
            else {
                item.icon = this._faviconUrl(feed);
            }
            this._refreshLabel(feed); // start async
            nodes.push(item);
        }
        return nodes;
    },


    observe: function FeedList_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'brief:invalidate-feedlist':
                ViewList.refreshItem('all-items-folder');
                ViewList.refreshItem('today-folder');
                ViewList.refreshItem('starred-folder');
                this.persistFolderState();
                this.rebuild();
                break;

            case 'brief:feed-title-changed':
            case 'brief:feed-favicon-changed':
                let feed = Storage.getFeed(aData);
                this.tree.updateElement(feed.feedID,
                    {title: feed.title, icon: this._faviconUrl(feed)});
                // TODO: should update FeedView and feed view title too(?)
                break;

            case 'brief:feed-updated': {
                this.tree.updateElement(aData, {loading: false, error: false});
                refreshProgressmeter();
                break;
            }

            case 'brief:feed-loading': {
                this.tree.updateElement(aData, {loading: true});
                break;
            }

            case 'brief:feed-error': {
                this.tree.updateElement(aData, {error: true});
                break;
            }

            case 'brief:feed-update-queued':
                refreshProgressmeter();
                break;

            case 'brief:feed-update-finished':
                refreshProgressmeter(aData);

                if (aData == 'cancelled') {
                    for (let feed of Storage.getAllFeeds()) {
                        this.tree.updateElement(feed.feedID, {loading: false});
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
        for (let folder of this.tree.root.getElementsByTagName('tree-folder')) {
            if (folder.classList.contains('collapsed'))
                closedFolders += folder.dataset.id;
        }

        FeedList.tree.root.setAttribute('closedFolders', escape(closedFolders));
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
            Components.utils.import('resource://gre/modules/PlacesUtils.jsm');

            let txn = new PlacesRemoveItemTransaction(Number(feed.bookmarkID));
            PlacesUtils.transactionManager.doTransaction(txn);
        }
    }

}
