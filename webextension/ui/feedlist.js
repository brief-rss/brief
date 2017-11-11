'use strict';

// An almost generic TreeView component. Some custom structure is inlined in _updateElement
function TreeView(aElementOrId) {
    this.root = this._resolveElement(aElementOrId, "");
    this.prefix = this.root.classList.contains('unprefixed') ? "" : this.root.id + "__";
    this.template = this.root.querySelector('template');
    this._selectedElement = null;
    Array.forEach(this.root.children, node => {
        this._initElement(node);
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
        this._cleanup();
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
                let template = this.template.content;
                let selector = (node.children !== undefined) ? 'tree-folder' : 'tree-item';
                template = template.querySelector(selector);
                element = document.importNode(template, true);
                this._initElement(element);
            }
            element.classList.remove('deleted');
            this._updateElement(element, node);
            if(next === null) {
                aElement.appendChild(element);
            } else if(element !== next) {
                next.before(element);
            } else {
                next = next.nextSibling;
            }
        }
    },
    _initElement: function TreeView__initElement(element) {
        let target = element.nodeName !== 'tree-folder' ?
                element : element.querySelector('tree-folder-header');
        target.addEventListener('click', this);
        target.addEventListener('contextmenu', this); // Select before opening the context menu
        if(element.nodeName === 'tree-folder') {
            element.querySelector('.toggle-collapsed').addEventListener('click', this);
        }
    },
    updateElement: function TreeView_updateElement(aElement, aModel) {
        this._updateElement(aElement, aModel);
        this._cleanup();
    },
    _updateElement: function TreeView__updateElement(aElement, aModel) {
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
    _cleanup: function TreeView__cleanup() {
        // Move the selection
        let selection = this.selectedItem;
        let next_selection = this.selectedItem;
        while(selection) {
            if(selection.classList.contains('collapsed'))
                next_selection = selection;
            if(selection.classList.contains('deleted'))
                next_selection = selection.parentNode;
            selection = selection.parentNode;
            if(selection === this.root)
                selection = null;
        }
        if(next_selection === this.root)
            next_selection = null;
        if(this.selectedItem !== next_selection)
            this.selectedItem = next_selection;
        //And then purge
        Array.forEach(this.root.querySelectorAll('tree-item.deleted, tree-folder.deleted'),
            node => node.parentNode.removeChild(node));
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
        if(aEvent.type === 'click' && aEvent.currentTarget.classList.contains('toggle-collapsed')) {
            // (un)collapse
            let element = aEvent.currentTarget;
            while(element.nodeName !== 'tree-folder') {
                element = element.parentNode;
            }
            element.classList.toggle('collapsed');
            aEvent.stopPropagation();
            this._cleanup(); // Move selection
        } else {
            let target = aEvent.currentTarget;
            if(target.nodeName === 'tree-folder-header')
                target = target.parentNode;
            this.selectedItem = target;
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
        this.tree.root.addEventListener(
            'change', event => this.onSelect(event), {passive: true});

        this.deselect();

        this.refreshItem('all-items-folder');
        this.refreshItem('today-folder');
        this.refreshItem('starred-folder');
    },

    getQueryForView: function(aViewID) {
        switch (aViewID) {
            case 'all-items-folder':
                return {
                    includeFeedsExcludedFromGlobalViews: false,
                    deleted: false
                };
            case 'today-folder':
                return {
                    startDate: new Date().setHours(0, 0, 0, 0),
                    includeFeedsExcludedFromGlobalViews: false,
                    deleted: false
                };
            case 'starred-folder':
                return {
                    deleted: false,
                    starred: true
                };
            case 'trash-folder':
                return {
                    deleted: 'trashed'
                };
        }
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
            TagList.show();
        } else {
            TagList.hide();
        }

        let title = this.selectedItem.getElementsByClassName('title')[0].textContent;
        let query = this.getQueryForView(this.selectedItem.id);
        gCurrentView = new FeedView(title, query);
    },

    refreshItem: async function ViewList_refreshItem(aItemID) {
        let query = this.getQueryForView(aItemID);
        query.read = false;

        let unreadCount = await API.query.getEntryCount(query);

        this.tree.updateElement(aItemID, {unreadCount});
    }
}


let TagList = {

    ready: false,

    tags: null,

    init() {
        this.tree.root.addEventListener(
            'change', event => this.onSelect(event), {passive: true});
    },

    get selectedItem() {
        return this.tree.selectedItem;
    },

    get tree() {
        delete this.tree;
        return this.tree = new TreeView('tag-list');
    },

    show: async function TagList_show() {
        if (!this.ready)
            await this._rebuild();

        document.body.classList.toggle('tag-list', this.tags !== null && this.tags.length > 0);
    },

    hide: function TagList_hide() {
        document.body.classList.remove('tag-list');
    },

    deselect: function TagList_deselect() {
        this.tree.selectedItem = null;
    },

    onSelect: function TagList_onSelect(aEvent) {
        if (!this.selectedItem) {
            if(!FeedList.selectedItem && !ViewList.selectedItem)
                ViewList.selectedItem = getElement('starred-folder')
            return;
        }

        ViewList.deselect();
        FeedList.deselect();

        let query = {
            deleted: false,
            tags: [this.selectedItem.dataset.id]
        }

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
    refreshTags: function TagList_refreshTags(aTags, aPossiblyAdded, aPossiblyRemoved) {
        if (!this.ready)
            return;

        let unknownTags = aTags.filter(t => !this.tags.includes(t));

        if(aPossiblyRemoved || unknownTags.length) {
            this._rebuild(); // spawn async
        } else {
            for(let tag of aTags) {
                this._refreshLabel(tag); // spawn async
            }
        }
    },

    _rebuild: async function TagList__rebuild() {
        let tagList = await API.getAllTags();

        if(this.tags !== tagList) {
            this.tags = tagList;

            let model = this.tags.map(tag => ( {id: tag, title: tag} ));
            this.tree.update(model);
        }

        for (let tagName of this.tags) {
            this._refreshLabel(tagName); // spawn async
        }

        this.ready = true;
    },

    _refreshLabel: async function TagList__refreshLabel(aTagName) {
        let query = {
            deleted: false,
            tags: [aTagName],
            read: false
        };
        let unreadCount = await API.query.getEntryCount(query);
        this.tree.updateElement(aTagName, {unreadCount});
    }

}


let FeedList = {

    _feedsCache: null,

    init() {
        this.tree.root.addEventListener(
            'change', event => this.onSelect(event), {passive: true});
    },

    updateFeedsCache: async function FeedList_updateFeedsCache() {
        this._feedsCache = await API.getAllFeeds(true, true);
    },

    getAllFeeds: function FeedList_getAllFeeds(includeFolders, includeHidden) {
        if(this._feedsCache === null)
            throw "FeedList: getAllFeeds called while cache is not ready"

        return this._feedsCache.filter(
            f => (!f.isFolder || includeFolders) && (!f.hidden || includeHidden)
        )
    },

    getFeed: function FeedList_getFeed(feedID) {
        if(this._feedsCache === null)
            throw "FeedList: getFeed called while cache is not ready"

        for (let feed of this._feedsCache) {
            if (feed.feedID == feedID)
                return feed;
        }

        return null;
    },

    get tree() {
        delete this.tree;
        return this.tree = new TreeView('feed-list');
    },

    get selectedItem() {
        return this.tree.selectedItem;
    },

    get selectedFeed() {
        return this.selectedItem ? this.getFeed(this.selectedItem.dataset.id) : null;
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

        let query = { deleted: false };

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
        for (let feed of aFeeds.map(id => this.getFeed(id))) {
            this._refreshLabel(feed);

            // Build an array of IDs of folders in the the parent chains of
            // the given feeds.
            let folders = [];
            let parentID = feed.parent;

            while (parentID != PrefCache.homeFolder) {
                if (folders.indexOf(parentID) == -1)
                    folders.push(parentID);
                parentID = this.getFeed(parentID).parent;
            }

            folders.map(id => this.getFeed(id)).forEach(this._refreshLabel, this); // start async
        }
    },

    _refreshLabel: async function FeedList__refreshLabel(aFeed) {
        let query = {
            deleted: false,
            folders: aFeed.isFolder ? [aFeed.feedID] : undefined,
            feeds: aFeed.isFolder ? undefined : [aFeed.feedID],
            read: false
        };

        let unreadCount = await API.query.getEntryCount(query);
        this.tree.updateElement(aFeed.feedID, {title: aFeed.title, unreadCount});
    },

    _faviconUrl: function FeedList__faviconUrl(aFeed) {
        if (PrefCache.showFavicons && aFeed.favicon && aFeed.favicon != 'no-favicon')
            return aFeed.favicon;
        return "chrome://brief/skin/icons/default-feed-favicon.png";
    },

    rebuild: function FeedList_rebuild(urlToSelect) {
        let active = (this.tree.selectedItem !== null);
        this.feeds = this.getAllFeeds(true);

        let model = this._buildFolderChildren(PrefCache.homeFolder);
        this.tree.update(model);

        if(urlToSelect !== undefined && urlToSelect !== null) {
            let targetFeed = this.feeds.filter(({feedURL}) => feedURL === urlToSelect)[0];
            if(targetFeed !== undefined) {
                this.tree.selectedItem = targetFeed.feedID;
                this.tree.selectedItem.scrollIntoView();
            }
        } else if(active && this.tree.selectedItem === null) {
            ViewList.selectedItem = getElement('all-items-folder');
        }
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
                let sep = closedFolders.match("_") ? "_" : ""; // compat with old no-separator
                item.collapsed = closedFolders.match(sep + escape(feed.feedID) + sep);

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


    observe: async function FeedList_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'brief:invalidate-feedlist':
                await this.updateFeedsCache();
                ViewList.refreshItem('all-items-folder');
                ViewList.refreshItem('today-folder');
                ViewList.refreshItem('starred-folder');
                this.persistFolderState();
                this.rebuild();
                break;

            case 'brief:feed-title-changed':
            case 'brief:feed-favicon-changed':
                await this.updateFeedsCache();
                let feed = this.getFeed(aData);
                this.tree.updateElement(feed.feedID,
                    {title: feed.title, icon: this._faviconUrl(feed)});
                // TODO: should update FeedView and feed view title too(?)
                break;

            case 'brief:feed-view-mode-changed':
                await this.updateFeedsCache();
                if(this.selectedFeed && this.selectedFeed.feedID === aData)
                    gCurrentView.refresh();
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
                refreshProgressmeter();

                if (aData == 'cancelled') {
                    for (let feed of this.getAllFeeds()) {
                        this.tree.updateElement(feed.feedID, {loading: false});
                    }
                }
                break;

            case 'brief:custom-style-changed':
                window.location.reload(/* bypassCache: */ true);
                break;
        }
    },


    observeStorage: function FeedList_observeStorage(event, args) {
        let {entryList, tagName, newState} = args;
        switch(event) {
            case 'entriesAdded':
            case 'entriesUpdated':
                this.refreshFeedTreeitems(entryList.feeds);
                ViewList.refreshItem('all-items-folder');
                ViewList.refreshItem('starred-folder');
                ViewList.refreshItem('today-folder');
                TagList.refreshTags(entryList.tags);
                break;
            case 'entriesDeleted':
                let entriesRestored = (newState === false);
                // First handle new/deleted tags
                TagList.refreshTags(entryList.tags, entriesRestored, !entriesRestored);
                // fallthrough
            case 'entriesMarkedRead':
                wait(250).then(() =>
                    FeedList.refreshFeedTreeitems(entryList.feeds)
                )

                wait(500).then(() => {
                    ViewList.refreshItem('all-items-folder');
                    ViewList.refreshItem('today-folder');
                    ViewList.refreshItem('starred-folder');
                    TagList.refreshTags(entryList.tags);
                })
                break;
            case 'entriesStarred':
                ViewList.refreshItem('starred-folder');
                break;
            case 'entriesTagged':
                if (ViewList.selectedItem && ViewList.selectedItem.id == 'starred-folder')
                    TagList.show();

                TagList.refreshTags([tagName], newState, !newState);
                break;
        }
    },


    persistFolderState: function FeedList_persistFolderState() {
        let closedFolders = '_';
        for (let folder of this.tree.root.getElementsByTagName('tree-folder')) {
            if (folder.classList.contains('collapsed'))
                closedFolders += folder.dataset.id + '_';
        }

        FeedList.tree.root.setAttribute('closedFolders', escape(closedFolders));
    }
}


// Custom menu handler to avoid Firefox default items on the Brief context menu
let ContextMenuModule = {
    _observer: null,
    _currentTarget: null,

    init: function ContextMenu_init() {
        this._observer = new MutationObserver((records, observer) => this._observeMutations(records));
        this._observer.observe(document, {subtree: true,
            childList: true, attributes: true, attributeFilter: ['contextmenu', 'data-dropdown']});

        this._initSubtrees([document.documentElement]);

        document.addEventListener('blur', event => this._hide(event));
        document.addEventListener('contextmenu', event => this.show(event));
        document.addEventListener('click', event => this.show(event));
    },

    show: function ContextMenu__show(event) {
        if(this._currentTarget === null || event.defaultPrevented)
            return;
        event.preventDefault();
        let target = this._currentTarget;
        let show_dropdown = (event.type !== 'contextmenu');
        let attribute = show_dropdown ? 'data-dropdown' : 'contextmenu';
        let menu = target.getAttribute(attribute);
        if(!menu)
            return;
        menu = document.getElementById(menu);
        menu.dispatchEvent(new Event('show'));
        // Positioning
        let left = event.clientX;
        let top = event.clientY;
        if(top + menu.scrollHeight > window.innerHeight)
            top = window.innerHeight - menu.scrollHeight;
        if(left + menu.scrollWidth > window.innerWidth)
            left = window.innerWidth - menu.scrollWidth;
        if(show_dropdown) {
            let rect = target.getBoundingClientRect();
            if(menu.dataset.align === 'center') {
                left = rect.left + rect.width / 2;
            } else {
                left = rect.left;
            }
            top = rect.top + rect.height;
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.classList.add('visible');
        menu.parentNode.classList.add('menu-visible');
    },

    _target: function ContextMenu__target({type, currentTarget}) {
        if(this._currentTarget !== null)
            return;
        let attribute_name = (type === 'click') ? 'data-dropdown' : 'contextmenu';
        if(currentTarget.hasAttribute(attribute_name))
            this._currentTarget = currentTarget;
    },

    _hide: function ContextMenu__hide(event) {
        this._currentTarget = null;
        event.preventDefault();
        Array.forEach(document.querySelectorAll('context-menu.visible'), node => {
            node.classList.remove('visible');
            node.parentNode.classList.remove('menu-visible');
        });
    },

    _observeMutations: function ContextMenu__observeMutations(records) {
        let targets = new Set();
        for(let {target, addedNodes} of records) {
            let nodes = addedNodes || [target];
            for(let node of nodes) {
                if(node.nodeType === Node.ELEMENT_NODE)
                    targets.add(node);
            }
        }
        if(targets.size > 0)
            this._initSubtrees(targets);
    },

    HANDLERS: [
        ['[contextmenu]', 'contextmenu', event => ContextMenuModule._target(event)],
        ['[data-dropdown]', 'click', event => ContextMenuModule._target(event)],
        ['context-menu-set', 'contextmenu', event => ContextMenuModule._hide(event)],
        ['context-menu-set', 'click', event => ContextMenuModule._hide(event)],
    ],

    _initSubtrees: function ContextMenu__initSubtrees(nodes) {
        for(let [selector, event, handler] of this.HANDLERS) {
            for(let node of nodes) {
                if(node.matches(selector))
                    node.addEventListener(event, handler);
                node.querySelectorAll(selector).forEach(node => {
                    node.addEventListener(event, handler);
                });
            }
        }
    },
};


let ViewListContextMenu = {

    get menu() {
        delete this.menu;
        return this.menu = document.getElementById('view-list-context-menu');
    },

    targetItem: null,

    init: function ViewListContextMenu_init() {
        this.targetItem = ViewList.selectedItem;
        this.menu.dataset.target = this.targetItem.id;
    },

    markFolderRead: function ViewListContextMenu_markFolderRead() {
        API.query.markEntriesRead(ViewList.getQueryForView(this.targetItem.id), true);
    },

    emptyTodayFolder: function ViewListContextMenu_emptyTodayFolder() {
        let query = ViewList.getQueryForView('today-folder');
        query.starred = false;
        API.query.deleteEntries(query, 'trashed');
    }

}


let TagListContextMenu = {

    markTagRead: function TagListContextMenu_markTagRead() {
        let query = {
            deleted: false,
            tags: [TagList.selectedItem.dataset.id]
        };
        API.query.markEntriesRead(query, true);
    },

    deleteTag: async function TagListContextMenu_deleteTag() {
        let tag = TagList.selectedItem.dataset.id;

        let text = STRINGS.formatStringFromName('confirmTagDeletionText', [tag], 1);

        if (!window.confirm(text))
            return;

        await API.deleteTag(tag);
    }

}


let FeedListContextMenu = {

    get menu() {
        delete this.menu;
        return this.menu = document.getElementById('feed-list-context-menu');
    },

    init: function FeedContextMenu_init() {
        let folder = FeedList.selectedItem.nodeName === 'tree-folder';
        this.menu.classList.toggle('folder', folder);

        if(!folder) {
            this.targetFeed = FeedList.getFeed(FeedList.selectedItem.dataset.id);
            document.getElementById('ctx-open-website').disabled = !this.targetFeed.websiteURL;
        }
    },

    markFeedRead: function FeedContextMenu_markFeedRead() {
        let query = {
            feeds: [this.targetFeed.feedID],
            deleted: false
        };
        API.query.markEntriesRead(query, true);
    },

    markFolderRead: function FolderContextMenu_markFolderRead() {
        let query = {
            deleted: false,
            folders: [FeedList.selectedFeed.feedID]
        };
        API.query.markEntriesRead(query, true);
    },

    updateFolder: function FolderContextMenu_updateFolder() {
        let feeds = [];
        for (let item of FeedList.selectedItem.getElementsByTagName('tree-item'))
            feeds.push(item.dataset.id);

        API.updateFeeds(feeds);
    },

    emptyFolder: function FolderContextMenu_emptyFolder() {
        let query = {
            deleted: false,
            starred: false,
            folders: [FeedList.selectedFeed.feedID]
        };
        API.query.deleteEntries(query, 'trashed');
    },

    deleteFolder: function FolderContextMenu_deleteFolder() {
        let item = FeedList.selectedItem;
        let feed = FeedList.selectedFeed;

        let text = STRINGS.formatStringFromName('confirmFolderDeletionText', [feed.title], 1);

        if (window.confirm(text))
            API.deleteFolder(Number(feed.bookmarkID));
    }

}
