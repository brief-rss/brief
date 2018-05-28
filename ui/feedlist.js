import {Database} from "/scripts/database.js";
import {Prefs} from "/scripts/prefs.js";
import {OPML} from "/scripts/opml.js";
import {Comm} from "/scripts/utils.js";
import {Commands, Persistence, Shortcuts, getElement} from "./brief.js";
import {FeedView} from "./feedview.js";


export var gCurrentView;

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
        this._cascadeState();
        this._cleanup();
    },
    _updateChildren: function TreeView__updateChildren(aElement, aModel) {
        let knownIds = new Set(aModel.map(node => node.id));
        let next = aElement.children.item(0);
        const IMPL_ITEMS = ['template', 'tree-folder-header', 'tree-folder-footer'];
        for (let node of aModel) {
            // Skip or delete everything that's not to stay
            while(next !== null && (!next.hasOwnProperty('id') || !knownIds.has(next.id))) {
                if(!IMPL_ITEMS.includes(next.nodeName)) {
                    if(next.nodeType !== Node.ELEMENT_NODE) {
                        // Just ignore them
                    } else {
                        next.classList.add('deleted');
                    }
                }
                if(next.nodeName === 'tree-folder-footer') {
                    break;
                }
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
        let type = element.nodeName;
        const CHILDREN = ['tree-folder-header', 'tree-folder-footer'];
        for(let selector of CHILDREN) {
            for(let node of element.querySelectorAll(selector)) {
                this._initElement(node);
            }
        }
        switch(type) {
            case 'tree-item':
            case 'tree-folder-header':
                element.addEventListener('click', this);
                // Select before opening the context menu
                element.addEventListener('contextmenu', this);
                element.addEventListener('dragstart', this);
                // Fallthrough
            case 'tree-folder-footer':
                element.addEventListener('dragenter', this);
                element.addEventListener('dragover', this);
                element.addEventListener('drop', this);
                break;
            case 'tree-folder':
                element.querySelector('.toggle-collapsed').addEventListener('click', this);
        }
        for(let node of element.querySelectorAll('.editable')) {
            node.addEventListener('blur', this);
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
        let footerText = element.querySelector('tree-folder-footer > .title');
        if(footerText) {
            footerText.textContent = '';
        }
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

    handleEvent: function TreeView__handleEvent(event) {
        let {type, target, dataTransfer} = event;
        if(type === 'dragstart') {
            if(target.localName === 'tree-folder-header') {
                target = target.parentNode;
            }
            dataTransfer.setData('application/x-moz-node', target);
            let items = [target, ...target.querySelectorAll('[data-id]')];
            dataTransfer.setData('application/x-tree-item-list',
                                 JSON.stringify(items.map(i => i.dataset.id)));
            dataTransfer.effectAllowed = 'move';
            dataTransfer.dropEffect = 'move';
            this.root.classList.add('drag');
            return;
        }
        if(type === 'dragenter' || type === 'dragover') {
            if(dataTransfer.types.includes('application/x-tree-item-list')) {
                event.preventDefault();
            }
            return;
        }
        if(type === 'drop') {
            let targetNode = event.currentTarget;
            if(['tree-folder-header', 'tree-folder-footer'].includes(targetNode.localName)) {
                targetNode = targetNode.parentNode;
            }
            event.preventDefault();
            let ev = new CustomEvent('move');
            let list = dataTransfer.getData('application/x-tree-item-list');
            ev.itemIds = JSON.parse(list);
            ev.targetId = targetNode.dataset.id;
            ev.relation = 'before';
            if(event.currentTarget.localName === 'tree-folder-footer') {
                ev.relation = 'into';
            }
            this.root.dispatchEvent(ev);
            this.root.classList.remove('drag');
            return;
        } else if(type === 'dragend') {
            this.root.classList.remove('drag');
        }

        // Title editing finished
        if(type === 'blur') {
            //TODO: fix layering violation
            let item = target.parentNode.parentNode;
            if(target.parentNode.nodeName === 'tree-folder-footer') {
                FeedList._append({feedID: item.dataset.id, title: target.textContent});
            } else {
                FeedList._rename({feedID: item.dataset.id, title: target.textContent});
            }
        }

        if(event.type === 'click' && event.currentTarget.classList.contains('toggle-collapsed')) {
            // (un)collapse
            let element = event.currentTarget;
            while(element.nodeName !== 'tree-folder') {
                element = element.parentNode;
            }
            element.classList.toggle('collapsed');
            event.stopPropagation();
            this._cleanup(); // Move selection
            Persistence.save(); // TODO: fix in a more clean way
        } else if(event.type === 'click' || event.type === 'contextmenu') {
            if(this.root.classList.contains('organize')) {
                return;
            }
            let target = event.currentTarget;
            if(target.nodeName === 'tree-folder-header')
                target = target.parentNode;
            this.selectedItem = target;
        }
    },

    organize() {
        this.root.classList.toggle('organize');
        this._cascadeState();
    },

    // Sync attributes that (like `contenteditable`) needs to be cascaded from classes by hand
    _cascadeState() {
        let active = this.root.classList.contains('organize');

        for(let node of this.root.querySelectorAll('tree-item, tree-folder-header')) {
            node.setAttribute('draggable', active);
        }
        for(let node of this.root.querySelectorAll('.editable')) {
            node.setAttribute('contenteditable', active);
        }
        for(let node of this.root.querySelectorAll('tree-folder-footer .editable')) {
            node.textContent = '';
        }
    },
};

export let ViewList = {
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
                    sortOrder: 'date',
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

    onSelect: function ViewList_onSelect() {
        if (!this.selectedItem)
            return;

        TagList.deselect();
        FeedList.deselect();

        if (this.selectedItem.id == 'starred-folder') {
            TagList.show();
        } else {
            TagList.hide();
        }
        //TODO: fix initial view saving

        let title = this.selectedItem.getElementsByClassName('title')[0].textContent;
        let query = this.getQueryForView(this.selectedItem.id);
        gCurrentView = new FeedView(title, query);
    },

    refreshItem: async function ViewList_refreshItem(aItemID) {
        let query = this.getQueryForView(aItemID);
        query.read = false;

        let unreadCount = await Database.query(query).count();

        this.tree.updateElement(aItemID, {unreadCount});
    },

    async refresh() {
        await Promise.all([
            this.refreshItem('all-items-folder'),
            this.refreshItem('today-folder'),
            this.refreshItem('starred-folder'),
        ]);
    },
}


export let TagList = {

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

    onSelect: function TagList_onSelect() {
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
        let tagList = []; //TODO: restore tag list

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
        let unreadCount = await Database.query(query).count();
        this.tree.updateElement(aTagName, {unreadCount});
    }

}


export let FeedList = {

    _feedsCache: null,
    _built: false,

    init() {
        // TODO: observers should be here
        this._feedsCache = Database.feeds;
        this.tree.root.addEventListener(
            'change', event => this.onSelect(event), {passive: true});
        this.tree.root.addEventListener(
            'move', event => this.onMove(event), {passive: true});
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

    onSelect: function FeedList_onSelect() {
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

    onMove({targetId, itemIds, relation}) {
        if(itemIds.includes(targetId)) {
            return; //TODO: block while dragging?
        }
        let others = [...Database.feeds].filter(feed => !itemIds.includes(feed.feedID));
        let otherIds = others.map(f => f.feedID);

        let parent;
        let position;
        switch(relation) {
            case 'before':
                parent = Database.getFeed(targetId).parent;
                position = otherIds.indexOf(targetId);
                break;
            case 'after':
                parent = Database.getFeed(targetId).parent;
                position = otherIds.indexOf(targetId) + 1;
                break;
            case 'into':
                parent = targetId || String(Prefs.get('homeFolder'));
                if(!targetId) {
                    // Insertion into root folder
                    position = others.length;
                } else {
                    let ancestor = parent;
                    let parentIndex = otherIds.indexOf(parent);
                    // Walk up the tree
                    position = -1;
                    while(position === -1) {
                        ancestor = Database.getFeed(ancestor).parent;
                        position = others.map(f => f.parent).indexOf(ancestor, parentIndex + 1);
                        if(ancestor === String(Prefs.get('homeFolder')) && position === -1) {
                            // Insertion into end
                            position = others.length;
                        }
                    }
                }
                break;
        }
        otherIds.splice(position, 0, ...itemIds);
        let changes = [{feedID: itemIds[0], parent}];
        for(let [index, feedID] of otherIds.entries()) {
            changes.push({feedID, rowIndex: index + 1});
        }
        Database.modifyFeed(changes);
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

            while (parentID != String(Prefs.get('homeFolder'))) {
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

        let unreadCount = await Database.query(query).count();
        this.tree.updateElement(aFeed.feedID, {title: aFeed.title || aFeed.feedURL, unreadCount});
    },

    _faviconUrl: function FeedList__faviconUrl(aFeed) {
        if (Prefs.get('showFavicons') && aFeed.favicon && aFeed.favicon != 'no-favicon')
            return aFeed.favicon;
        return "/icons/default-feed-favicon.png";
    },

    rebuild: function FeedList_rebuild(feeds) {
        if(this._built) {
            this.persistFolderState();
        }
        let headlines = gCurrentView && gCurrentView.headlinesMode;
        this._feedsCache = feeds || Database.feeds;
        if(gCurrentView && headlines !== gCurrentView.headlinesMode) {
            gCurrentView.refresh();
        }
        let active = (this.tree.selectedItem !== null);
        this.feeds = this.getAllFeeds(true);

        let model = this._buildFolderChildren(String(Prefs.get('homeFolder')));
        this.tree.update(model);

        if(active && this.tree.selectedItem === null) {
            ViewList.selectedItem = getElement('all-items-folder');
        }
        this._built = true;
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
                title: feed.title || feed.feedURL, // No title possible before the first fetch
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

    persistFolderState: function FeedList_persistFolderState() {
        let closedFolders = '_';
        for (let folder of this.tree.root.getElementsByTagName('tree-folder')) {
            if (folder.classList.contains('collapsed'))
                closedFolders += folder.dataset.id + '_';
        }

        FeedList.tree.root.setAttribute('closedFolders', escape(closedFolders));
    },

    organize() {
        this.tree.organize();
        let active = this.tree.root.classList.contains('organize');
        getElement('organize-button').classList.toggle('organize', active);
        Shortcuts.mode = active ? 'organize' : 'command';
    },

    _rename({feedID, title}) {
        if(title === '') {
            this.rebuild();
            return;
        }
        let feed = Database.getFeed(feedID);
        if(feed.title !== title) {
            Database.modifyFeed({feedID, title});
        }
    },

    _append({feedID, title}) {
        if(title === '') {
            this.rebuild();
            return;
        }
        Database.addFeeds({title, parent: feedID})
    },
}


// Custom menu handler to avoid Firefox default items on the Brief context menu
export let ContextMenuModule = {
    _observer: null,
    _currentTarget: null,

    init: function ContextMenu_init() {
        this._observer = new MutationObserver((records) => this._observeMutations(records));
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
        this._currentTarget = null;
    },

    _target: function ContextMenu__target({type, currentTarget}) {
        if(this._currentTarget !== null)
            return;
        let attribute_name = (type === 'click') ? 'data-dropdown' : 'contextmenu';
        if(currentTarget.hasAttribute(attribute_name))
            this._currentTarget = currentTarget;
    },

    _hide: function ContextMenu__hide() {
        this._currentTarget = null;
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


export let ViewListContextMenu = {
    build() {
        const handlers = {
            'ctx-mark-special-folder-read': () => this.markFolderRead(),
            'ctx-restore-trashed': () => Commands.restoreTrashed(),
            'ctx-empty-today-folder': () => this.emptyUnreadFolder(),
            'ctx-empty-trash': () => Commands.emptyTrash(),
        };

        for(let id in handlers) {
            document.getElementById(id).addEventListener('click', handlers[id]);
        }
        document.getElementById('view-list-context-menu')
            .addEventListener('show', () => this.init());
    },

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
        Database.query(ViewList.getQueryForView(this.targetItem.id)).markRead(true);
    },

    emptyTodayFolder: function ViewListContextMenu_emptyTodayFolder() {
        let query = ViewList.getQueryForView('today-folder');
        query.starred = false;
        Database.query(query).markDeleted('trashed');
    }

}


export let TagListContextMenu = {
    build() {
        const handlers = {
            'ctx-mark-tag-read': () => this.markTagRead(),
            'ctx-delete-tag': () => this.deleteTag(),
        };

        for(let id in handlers) {
            document.getElementById(id).addEventListener('click', handlers[id]);
        }
    },

    markTagRead: function TagListContextMenu_markTagRead() {
        let query = {
            deleted: false,
            tags: [TagList.selectedItem.dataset.id]
        };
        Database.query(query).markRead(true);
    },

    deleteTag: async function TagListContextMenu_deleteTag() {
        let tag = TagList.selectedItem.dataset.id;

        let text = browser.i18n.getMessage('confirmTagDeletionText', tag);

        if (!window.confirm(text))
            return;

        //TODO: restore tag list functionality
    }

}


export let FeedListContextMenu = {
    build() {
        const handlers = {
            'ctx-mark-feed-read': () => this.markFeedRead(),
            'ctx-update-feed': () => Comm.callMaster('update-feeds',
                                                     {feeds: [this.targetFeed.feedID]}),
            'ctx-open-website': () => Commands.openFeedWebsite(this.targetFeed),
            'ctx-unsubscribe-feed': () => Commands.deleteFeed(this.targetFeed),
            'ctx-empty-feed': () => Commands.emptyFeed(this.targetFeed),
            'ctx-feed-settomgs': () => Commands.showFeedProperties(this.targetFeed),

            'ctx-mark-folder-read': () => this.markFolderRead(),
            'ctx-refresh-folder': () => this.updateFolder(),
            'ctx-delete-folder': () => this.deleteFolder(),
            'ctx-empty-folder': () => this.emptyFolder(),
        };

        for(let id in handlers) {
            document.getElementById(id).addEventListener('click', handlers[id]);
        }
        document.getElementById('feed-list-context-menu')
            .addEventListener('show', () => this.init());
    },

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
        Database.query(query).markRead(true);
    },

    markFolderRead: function FolderContextMenu_markFolderRead() {
        let query = {
            deleted: false,
            folders: [FeedList.selectedFeed.feedID]
        };
        Database.query(query).markRead(true);
    },

    updateFolder: function FolderContextMenu_updateFolder() {
        let feeds = [];
        for (let item of FeedList.selectedItem.getElementsByTagName('tree-item'))
            feeds.push(item.dataset.id);

        Comm.callMaster('update-feeds', {feeds});
    },

    emptyFolder: function FolderContextMenu_emptyFolder() {
        let query = {
            deleted: false,
            starred: false,
            folders: [FeedList.selectedFeed.feedID]
        };
        Database.query(query).markDeleted('trashed');
    },

    deleteFolder: function FolderContextMenu_deleteFolder() {
        let feed = FeedList.selectedFeed;

        let text = browser.i18n.getMessage('confirmFolderDeletionText', feed.title);

        if (window.confirm(text))
            Database.deleteFeed(feed);
    }

}

export let DropdownMenus = {
    build() {
        let opmlInput = document.getElementById('open-opml');
        const handlers = {
            'dropdown-shortcuts': () => Commands.displayShortcuts(),
            'dropdown-import': () => opmlInput.click(),
            'dropdown-export': () => OPML.exportFeeds(),
            'dropdown-options': () => browser.runtime.openOptionsPage(),
            'dropdown-update-feed': () => Comm.callMaster(
                'update-feeds', {feeds: [FeedList.selectedFeed.feedID]}),
            'brief-open-website': () => Commands.openFeedWebsite(),
            'dropdown-empty-feed': () => Commands.emptyFeed(),
            'dropdown-unsubscribe-feed': () => Commands.deleteFeed(),
            'dropdown-feed-settings': () => Commands.showFeedProperties(),
            'dropdown-restore-trashed': () => Commands.restoreTrashed(),
            'dropdown-empty-trash': () => Commands.emptyTrash(),
        };

        for(let id in handlers) {
            document.getElementById(id).addEventListener('click', handlers[id]);
        }
        opmlInput.addEventListener('change', () => {
            console.log('Got OPML');
            let file = opmlInput.files[0];
            OPML.importOPML(file);
        });
    },
}
