'use strict';

/**
 * Database design and considerations
 *
 * 1. Revision table.
 * Item content, as fetched from the server, is stored as a `revision`.
 * Revisions are intended to be immutable. For now there's only one revision per entry,
 * but this may change in the future.
 *
 * 2. Entry table.
 * An entry is an item from a feed.
 */
// IndexedDB does not play nice with `async` (transaction ends before execution restarts)
// and the same problem with native Promise
// mb1193394, fixed in Firefox 60
let Database = {
    // If upping, check migration in both _upgradeSchema and _upgradeEntry/_upgradeEntries
    DB_VERSION: 30,

    _db: null,
    db() {
        return this._db;
    },

    _feeds: [],
    get feeds() {
        return this._feeds;
    },

    getFeed(feedID) {
        let feed = this.feeds.filter(f => f.feedID === feedID)[0];
        if(feed === undefined) {
            return undefined;
        }
        return Object.assign({}, feed);
    },

    async init() {
        if(this._db)
            return;
        // Open current DB
        let {storage} = await browser.storage.local.get({storage: 'persistent'});
        let {db} = await this._open({
            storage,
            version: this.DB_VERSION,
            upgrade: this._upgradeSchema,
        });
        this._db = db;
        await this.loadFeeds();
        let entryCount = await this.countEntries();
        console.log(`Brief: opened database with ${entryCount} entries`);

        // Register all needed observers
        Comm.registerObservers({
            'feedlist-updated': ({feeds}) => this._feeds = feeds, // Already saved elsewhere
            'feedlist-modify': ({updates}) => this.modifyFeed(updates),
            'feedlist-add': ({feeds, options}) => this.addFeeds(feeds, options),
            'feedlist-delete': ({feeds}) => this.deleteFeed(feeds),
            'entries-expire': ({feeds}) => this.expireEntries(feeds),
        });

        if(Comm.master) {
            browser.bookmarks.onCreated.addListener((id, {url}) => {
                if(url === undefined) {
                    return;
                }
                this.query({entryURL: url, starred: 0})._update({
                    action: e => { e.starred = 1; },
                    changes: {starred: 1},
                });
            });
            browser.bookmarks.onRemoved.addListener((id, {node: {url}}) => {
                if(url === undefined) {
                    return;
                }
                this.query({entryURL: url, starred: 1})._update({
                    action: e => { e.starred = 0; },
                    changes: {starred: 0},
                });
            });
            //TODO: onChanged
            //FIXME: removed one of multiple not working
        }
    },

    async _open({name="brief", version=undefined, storage="default", upgrade=null}) {
        let description = `database in ${storage} storage`;
        let canUpgrade = (upgrade !== null);
        console.log(`Brief: opening ${description}${ canUpgrade ? " with upgrade" : "" }`);
        let openOptions = version;
        if(storage === 'persistent') {
            openOptions = {
                storage: 'persistent',
                version,
            };
        }
        let db;
        let upgradeFrom;
        let opener = indexedDB.open(name, openOptions);
        if(upgrade !== null) {
            opener.onupgradeneeded = (event) => upgrade(event);
        } else {
            opener.onupgradeneeded = ({target: {transaction: tx}, oldVersion}) => {
                upgradeFrom = oldVersion;
                tx.abort();
            };
        }
        try {
            db = await DbUtil.requestPromise(opener);
        } catch(e) {
            if(e.name === "AbortError" && !canUpgrade) {
                if(upgradeFrom === 0) {
                    console.info(`Found no ${description}`);
                } else {
                    console.info(`The ${description} needs upgrade, aborting`);
                }
            }
            return null;
        }
        console.log(`Brief: opened ${description}`);
        return {db};
    },

    _upgradeSchema(event) {
        let {oldVersion} = event;
        if(oldVersion === 0) {
            console.log(`Creating the database`);
        } else {
            console.log(`Upgrading from version ${event.oldVersion}`);
        }
        let {result: db, transaction: tx} = event.target;
        let revisions;
        let entries;
        switch(oldVersion) {
            case 0:
                revisions = db.createObjectStore("revisions", {
                    keyPath: "id", autoIncrement: true});
                // There could be a full-text index here, but let's avoid this
                entries = db.createObjectStore("entries", {
                    keyPath: "id", autoIncrement: true});
                entries.createIndex("date", "date");
                entries.createIndex("feedID_date", ["feedID", "date"]);
                entries.createIndex("primaryHash", "primaryHash"); // sorry, unused
                entries.createIndex("bookmarkID", "bookmarkID");
                entries.createIndex("entryURL", "entryURL");
                entries.createIndex("tagName", "tags", {multiEntry: true});
            // fallthrough
            case 10:
                let feeds = db.createObjectStore("feeds", {
                    keyPath: "feedID", autoIncrement: true});
                // No indices needed - the feed list is always loaded to memory
            // fallthrough
            case 20:
                entries = tx.objectStore('entries');
                // Enables quick unread filtering
                entries.deleteIndex("primaryHash"); // Unused
                entries.createIndex(
                    'deleted_starred_read_feedID_date',
                    ['deleted', 'starred', 'read', 'feedID', 'date']);
                entries.createIndex("_v", "_v"); // Used for gradual migration in big databases
                entries.createIndex("feedID_providedID", ["feedID", "providedID"]);
                entries.createIndex("feedID_entryURL", ["feedID", "entryURL"]);
                // TODO: introduce async editing migrations when possible
                let cursor = entries.openCursor();
                cursor.onsuccess = ({target}) => {
                    let cursor = target.result;
                    if(cursor) {
                        let value = cursor.value;
                        cursor.update(this._upgradeEntry(value));
                        cursor.continue();
                    }
                };
            // fallthrough
        }
    },

    _upgradeEntry(value) {
        // On next migration: add switch on _v?
        value.read = value.read ? 1 : 0;
        value.markedUnreadOnUpdate = value.markedUnreadOnUpdate ? 1 : 0;
        if(value.deleted === 1) {
            value.deleted = 'trashed';
        } else if(value.deleted === 2) {
            value.deleted = 'deleted';
        }
        delete value.bookmarked; // Use entry.starred
        delete value.primaryHash;
        delete value.secondaryHash;
        value._v = this.DB_VERSION;
        return value;
    },

    ENTRY_FIELDS: [
        'id', 'feedID',
        'read', 'markedUnreadOnUpdate', 'starred', 'tags', 'deleted',
        'providedID', 'entryURL',
        'date',
    ],
    REVISION_FIELDS: ['id', 'authors', 'title', 'content', 'updated'],

    query(filters) {
        if(filters === undefined) {
            filters = {};
        }
        if(typeof filters == 'number') {
            filters = {entries: [filters]};
        }
        else if (Array.isArray(filters)) {
            filters = {entries: filters};
        }

        return new Query(filters);
    },

    async countEntries() {
        let tx = this._db.transaction(['entries']);
        let request = tx.objectStore('entries').count();
        return await DbUtil.requestPromise(request);
    },

    async loadFeeds() {
        let tx = this._db.transaction(['feeds']);
        let request = tx.objectStore('feeds').getAll();
        let feeds = await DbUtil.requestPromise(request);
        console.log(`Brief: ${feeds.length} feeds in database`);

        if(feeds.length === 0) {
            console.log(`Brief: the database looks empty, testing backups`);
            ({feeds} = await browser.storage.local.get({feeds: []}));
            console.log(`Brief: ${feeds.length} feeds found in local storage`);
            if(feeds.length === 0) {
                ({feeds} = await browser.storage.sync.get({feeds: []}));
                console.log(`Brief: ${feeds.length} feeds found in sync storage`);
            }
            this._feeds = feeds;
            Comm.broadcast('feedlist-updated', {feeds});
            this.saveFeeds();
        }

        feeds = this._reindex(feeds);
        this._feeds = feeds;
    },

    async saveFeeds() {
        if(this._db === null) {
            return;
        }
        let feeds = Array.from(this.feeds);
        feeds.sort((a, b) => a.rowIndex - b.rowIndex); // Fallback, should be already sorted
        let tx = this._db.transaction(['feeds'], 'readwrite');
        tx.objectStore('feeds').clear();
        for(let feed of feeds) {
            tx.objectStore('feeds').put(feed);
        }
        await DbUtil.transactionPromise(tx);
        await this._saveFeedBackups(feeds);
        if(Comm.verbose) {
            console.log(`Brief: saved feed list with ${feeds.length} feeds`);
        }
    },

    async addFeeds(feeds, options) {
        if(!Comm.master) {
            return Comm.callMaster('feedlist-add', {feeds, options});
        }
        if(Comm.verbose) {
            console.log('addFeeds', feeds, options);
        }
        let parent = options ? options.parent : String(Prefs.get('homeFolder'));
        feeds = asArray(feeds);
        let newFeedIds = [];

        for(let feed of feeds) {
            let feedID = await this._addFeed(feed, {parent});
            if(feedID !== undefined) {
                newFeedIds.push(feedID);
            }
            if(feed.children !== undefined) {
                newFeedIds.push(...await this.addFeeds(
                    feed.children, {parent: feedID, nested: true}));
            }
        }
        if(!options || !options.nested) {
            await Database.saveFeeds();
            FeedUpdater.updateFeeds(newFeedIds);
        }
        return newFeedIds;
    },

    async _addFeed(feed, {parent}) {
        if(Comm.verbose) {
            console.log('_addFeed', feed, parent);
        }
        parent = feed.parent || parent; // Used for folder creation from Organize mode
        let {url, title} = feed;
        let existing = this.feeds.filter(f => !f.isFolder && f.feedURL === url);
        let active = existing.filter(f => !f.hidden);
        if(Comm.verbose) {
            console.log('_addFeed search', existing, active);
        }
        if(existing.length > 0) {
            if(active.length === 0) {
                console.log("Restoring hidden feed", existing[0]);
                this.modifyFeed({
                    feedID: existing[0].feedID,
                    hidden: 0,
                    parent,
                    rowIndex: 'tail',
                });
                return existing[0].feedID;
            } else {
                console.log("Feed already present", active[0]);
                return;
            }
        }

        let feedID;
        if(url) {
            feedID = await hashString(url);
        } else {
            let folderIds = this.feeds.filter(f => f.isFolder || false).map(f => Number(f.feedID));
            feedID = String(Math.max(1, ...folderIds) + 1);
        }
        console.log(`Need a new node ${feedID} from`, feed);
        let newFeed = {
            feedID,
            feedURL: url,
            title: title || '', // Will be filled in on the next update
            rowIndex: Math.max(0, ...this.feeds.map(f => f.rowIndex)) + 1,
            isFolder: !url,
            parent,
            hidden: 0,
            entryAgeLimit: 0,
            maxEntries: 0,
            updateInterval: 0,
            markModifiedEntriesUnread: 1,
            omitInUnread: 0,
            viewMode: 0,
            favicon: 'no-favicon',
            lastFaviconRefresh: 0,
            // These will be filled in when the feed is pushed
            websiteURL: feed.siteURL || '',
            subtitle: '',
            language: '',
            dateModified: 0,
            lastUpdated: 0,
            oldestEntryDate: 0,
        };
        console.log('Creating node', newFeed);
        this._feeds.push(newFeed);
        this._feeds = this._reindex(this._feeds);
        if(feed.siteURL) { // Otherwise on first update
            /*spawn*/ FaviconFetcher.updateFavicon(newFeed).catch(console.error);
        }
        return feedID;
    },

    async modifyFeed(props) {
        if(!Comm.master) {
            return Comm.callMaster('feedlist-modify', {updates: props});
        }
        Comm.verbose && console.log('modifyFeed', props);
        props = Array.isArray(props) ? props : [props];
        let reindex = false;
        for(let bag of props) {
            if(bag.rowIndex !== undefined && bag.rowIndex === 'tail') {
                bag.rowIndex = this.feeds[this.feeds.length - 1].rowIndex + 1;
            }
            if(bag.rowIndex) {
                reindex = true;
            }
            let feed = this.feeds.filter(f => f.feedID === bag.feedID)[0];
            for(let [k, v] of Object.entries(bag)) {
                if(feed[k] !== undefined && feed[k] === v) {
                    continue;
                }
                feed[k] = v;
                //TODO: expire entries
            }
        }
        if(reindex) {
            this._feeds = this._reindex(this._feeds);
        }
        Comm.broadcast('feedlist-updated', {feeds: this.feeds});

        await this.saveFeeds();
    },

    async deleteFeed(feeds) {
        if(!Comm.master) {
            return Comm.callMaster('feedlist-delete', {feeds});
        }
        if(!Array.isArray(feeds)) {
            feeds = [feeds];
        }
        feeds = this._includeChildren(feeds);
        feeds = feeds.map(f => ({feedID: f.feedID, hidden: Date.now()}));
        await this.modifyFeed(feeds);
    },

    async expireEntries(feeds) {
        if(!Comm.master) {
            return Comm.callMaster('entries-expire', {feeds});
        }
        let optionsOpen = await Comm.broadcast('is-options-window-open');
        if(optionsOpen) {
            // This could cause data loss while the user has enabled expiration
            // but not yet configured the limits (remember that options are instant-apply)
            console.log('Not expiring old entries while options / feed properties are open');
            return;
        } else {
            console.log('Expiring entries');
        }
        if(!feeds) {
            feeds = this.feeds;
        }
        feeds = asArray(feeds);

        // Count limits are global only
        //FIXME: can't use markDeleted directly as _update does not support offset/limit
        if (Prefs.get('database.limitStoredEntries')) {
            for (let feed of feeds) {
                let query = new Query({
                    feeds: [feed.feedID],
                    deleted: false,
                    starred: false,
                    sortOrder: 'date',
                    offset: Prefs.get('database.maxStoredEntries'),
                });
                let ids = await query.getIds();
                await this.query(ids).markDeleted('trashed');
            }
        }

        // Age limits
        // Global default per-feed limit...
        let feedsWithoutAgeLimit = feeds.filter(f => !f.entryAgeLimit);
        if (Prefs.get('database.expireEntries') && feedsWithoutAgeLimit.length) {
            let expirationAge = Prefs.get('database.entryExpirationAge');

            let query = new Query({
                feeds: feedsWithoutAgeLimit.map(feed => feed.feedID),
                deleted: false,
                starred: false,
                endDate: Date.now() - expirationAge * 86400000,
            });
            await query.markDeleted('trashed');
        }

        // Pre-feed age limit
        let feedsWithAgeLimit = feeds.filter(f => f.entryAgeLimit);
        if (feedsWithAgeLimit.length) {
            for (let feed of feedsWithAgeLimit) {
                let query = new Query({
                    feeds: [feed.feedID],
                    deleted: false,
                    starred: false,
                    endDate: Date.now() - feed.entryAgeLimit * 86400000
                });
                await query.markDeleted('trashed');
            }
        }
    },

    async pushUpdatedFeed({feed, parsedFeed}) {
        let now = Date.now();
        let entries = this._feedToEntries({feed, parsedFeed, now});
        let modified = now; // fallback
        if(parsedFeed.updated) {
            modified = parseDateValue(parsedFeed.updated);
        }
        if(!entries.length || (modified && modified <= feed.dateModified)) {
            return {entries: [], newEntries: []};
        }
        let newEntries = await this._pushFeedEntries({feed, entries});
        let feedUpdates = Object.assign({}, {
            feedID: feed.feedID,
            title: feed.title || parsedFeed.title,
            websiteURL: parsedFeed.link ? parsedFeed.link.href : '',
            subtitle: parsedFeed.subtitle ? parsedFeed.subtitle.text : '',
            oldestEntryDate: Math.min(entries.map(e => e.date)) || feed.oldestEntryDate,
            language: parsedFeed.language,
            lastUpdated: Date.now(),
            dateModified: modified,
        });
        await this.modifyFeed(feedUpdates);
        await this.expireEntries(feed);
        return newEntries;
    },

    async _pushFeedEntries({feed, entries}) {
        if(entries.length === 0) {
            return;
        }
        if(Comm.verbose) {
            console.log("Pushing entries:", entries, "to", feed);
        }
        let feedID = feed.feedID;
        let markUnread = feed.markModifiedEntriesUnread;
        let entriesById = new Map(); // providedID, if present, *must* be unique
        let entriesByUrl = new Map();
        let found = new Set();
        for(let entry of entries) {
            let {providedID, entryURL} = entry;
            if(feedID !== entry.feedID) {
                console.error(feed, entry);
                throw "pushFeedEntries cannot be used for multiple feeds at a time";
            }
            if(providedID) {
                entriesById.set(providedID, entry);
            }
            if(entryURL) {
                let array = entriesByUrl.get(entryURL) || [];
                array.push(entry);
                entriesByUrl.set(entryURL, array);
            }
        }
        let queryId = {feeds: feedID, providedID: Array.from(entriesById.keys())};
        let allEntries = [];
        let newEntries = []; // For update notification
        // Chain, scan 1: every entry with IDs provided
        await this.query(queryId)._update({
            stores: ['entries', 'revisions'],
            action: (entry, {tx}) => {
                let update = entriesById.get(entry.providedID);
                if(update === undefined) {
                    return;
                }
                found.add(update);
                entriesByUrl.delete(entry.entryURL);
                this._updateEntry(entry, update, {tx, markUnread});
                allEntries.push(entry);
            },
            then: ({tx}) => {
                let queryUrl = {feeds: feedID, entryURL: Array.from(entriesByUrl.keys())};
                // Chain, scan 2: URL-only entries
                this.query(queryUrl)._update({
                    tx,
                    // changes undefined to avoid duplicate notifications
                    stores: ['entries', 'revisions'],
                    action: (entry, {tx}) => {
                        let updateArray = entriesByUrl.get(entry.entryURL) || [];
                        updateArray = updateArray.filter(e => !found.has(e));
                        if(entry.providedID) { // If there's an ID, it's already known to mismatch
                            updateArray = updateArray.filter(e => !e.providedID);
                        }
                        if(!updateArray.length) {
                            return;
                        }
                        let update = updateArray.pop();
                        found.add(update);
                        this._updateEntry(entry, update, {tx, markUnread});
                        allEntries.push(entry);
                    },
                    then: ({tx}) => {
                        // Chain, part 3: completely new entries
                        let remainingEntries = entries.filter(e => !found.has(e));
                        for(let entry of remainingEntries) {
                            this._addEntry(entry, {tx, entries: newEntries});
                        }
                    },
                });
            },
        });
        allEntries.push(...newEntries);
        Comm.broadcast('entries-updated', {
            feeds: [feedID],
            entries: allEntries,
            changes: {content: true},
        });
        return {entries: allEntries, newEntries: newEntries};
    },

    _entryFromItem(next) {
        let revision = {
            title: next.title,
            content: next.content || next.summary,
            authors: next.authors,
            updated: next.updated || 0,
        };

        let entry = {
            _v: this.DB_VERSION,
            feedID: next.feedID,
            providedID: next.providedID,
            entryURL: next.entryURL,
            date: next.date || Date.now(),
            revisions: [revision],
            tags: [],
            read: 0,
            markedUnreadOnUpdate: 0,
            starred: 0,
            deleted: 0,
        };
        return entry;
    },

    _addEntry(next, {tx, entries}) {
        // Single-revision only for now
        let entry = next;
        if(entry.revisions === undefined) {
            entry = this._entryFromItem(entry);
        }

        let req = tx.objectStore('revisions').put(entry.revisions[0]);
        req.onsuccess = ({target}) => {
            entry.revisions[0] = {id: target.result};
            let req = tx.objectStore('entries').put(entry);
            req.onsuccess = ({target}) => {
                entry.id = target.result;
                entries.push(entry);
            };
        };
    },

    //TODO: fix this async horror show with some good abstractions
    _updateEntry(prev, next, {tx, markUnread}) {
        // Roughly equivalent to  legacy FeedProcessor.processEntry
        let revision = prev.revisions[0].id;
        let req = tx.objectStore('revisions').get(revision);
        req.onsuccess = ({target}) => {
            let revision = target.result;
            if(!revision.updated || next.updated <= revision.updated) {
                return;
            }
            if(next.updated === undefined && revision.updated) {
                console.warn('missing timestamps in a feed?', next);
            }
            revision.updated = next.updated;
            if(markUnread && prev.read) {
                prev.read = 0;
                prev.markedUnreadOnUpdate = 1;
            }
            revision.title = next.title;
            revision.content = next.content || next.summary;
            revision.authors = next.authors;
            tx.objectStore('entries').put(prev); // Sorry, _update's default save is before
            tx.objectStore('revisions').put(revision);
        }
        // May be missing due to a Brief<2.5.3:2.5 issue
        prev.providedID = prev.providedID || next.providedID;
    },

    _feedToEntries({feed, parsedFeed, now}) {
        // Roughly the legacy mapEntryProperties
        let entries = [];
        for(let src of (parsedFeed.items || [])) {
            let authors = (src.authors || []).map(a => a.name).filter(n => n).join(', ');
            let entry = {
                feedID: feed.feedID,
                providedID: src.id,
                title: (src.title || '').replace(/<[^>]+>/g, ''), // Strip tags
                entryURL: src.link.href,
                summary: src.summary,
                content: src.content,
                authors: authors,
                date: parseDateValue(src.published) || parseDateValue(src.updated) || now,
                updated: parseDateValue(src.updated) || now,
            };

            entries.push(entry);
        }
        let ids = entries.map(e => e.providedID).filter(i => i);
        if(ids.length !== (new Set(ids)).size) {
            console.error('feed has duplicate item IDs', feed, parsedFeed);
        }
        let urls = entries.map(e => e.entryURL).filter(u => u);
        if(urls.length !== (new Set(urls)).size) {
            // Note: this seems to be legal in RSS, but Brief does not support it yet
            console.error('feed has duplicate item URLs', feed, parsedFeed);
        }
        // In a feed the entries are traditionally ordered newest to oldest,
        // but the optimal insertion order is chronological to match IDs growth
        entries.reverse();
        return entries;
    },

    async _saveFeedBackups(feeds) {
        let minimizedFeeds = [];
        for(let feed of feeds) {
            let minimized = Object.assign({}, feed);
            for(let key of Object.getOwnPropertyNames(minimized)) {
                if(key === 'favicon')
                    delete minimized.favicon;
                if(minimized[key] === null)
                    delete minimized[key];
            }
            minimizedFeeds.push(minimized);
        }
        feeds = minimizedFeeds;
        let store_local = browser.storage.local.set({feeds});
        let store_sync = browser.storage.sync.set({feeds});
        await Promise.all([store_local, store_sync]);
    },

    _includeChildren(feeds) {
        feeds = feeds.map(f => f.feedID || f);
        let childrenMap = new Map();
        for(let node of Database.feeds) {
            let parent = node.parent;
            let children = childrenMap.get(parent) || [];
            children.push(node.feedID);
            childrenMap.set(parent, children);
        }
        let nodes = [];
        let new_nodes = feeds.slice();
        while(new_nodes.length > 0) {
            let node = new_nodes.pop();
            nodes.push(node);
            let children = childrenMap.get(node) || [];
            new_nodes.push(...children);
        }
        return Database.feeds.filter(f => nodes.includes(f.feedID));
    },

    _reindex(feeds) {
        // Fix possible negative rowIndex values after a Brief 2.5 bug
        for(let [idx, feed] of feeds.entries()) {
            if(!(feed.rowIndex > 0)) {
                feed.rowIndex = idx + 1;
            }
        }
        // Initial sort is needed as the IndexedDB order is by feedID, not rowIndex
        feeds.sort((a, b) => a.rowIndex - b.rowIndex);

        // Build all the children lists keeping relative order
        let parents = new Map();
        let fullFeeds = new Map();
        for(let feed of feeds) {
            let parent = feed.parent;
            let children = parents.get(parent) || [];
            children.push(feed.feedID);
            parents.set(parent, children);
            fullFeeds.set(feed.feedID, feed);
        }
        // Now flatten the main tree starting from the root
        let homeId = String(Prefs.get('homeFolder'));
        function flattenChildren(parents, id) {
            let list = [];
            let children = parents.get(id) || [];
            for(let child of children) {
                list.push(child, ...flattenChildren(parents, child));
            }
            return list;
        }
        let tree = flattenChildren(parents, homeId);
        let treeSet = new Set(tree);
        tree = tree.map(f => fullFeeds.get(f));
        // Ok, this is the most weird part: do we have anything not part of the tree (cycles, etc.)?
        for(let orphan of feeds.filter(f => !treeSet.has(f.feedID))) {
            orphan.parent = homeId;
            orphan.hidden = 1;
            tree.push(orphan);
        }
        // Finally reindex all feeds
        for(let [idx, feed] of tree.entries()) {
            feed.rowIndex = idx + 1;
        }

        return tree;
    },
};
//TODO: database cleanup
//TODO: bookmark to starred sync


function Query(filters) {
    Object.assign(this, filters);
};

Query.prototype = {

    /**
     * Array of IDs of entries to be selected.
     */
    entries: undefined,

    /**
     * Array of IDs of feeds containing the entries to be selected.
     */
    feeds: undefined,

    /**
     * Array of IDs of folders containing the entries to be selected.
     */
    folders: undefined,

    /**
     * Array of tags which selected entries must have.
     */
    tags: undefined,

    /**
     * Read state of entries to be selected.
     */
    read: undefined,

    /**
     * Starred state of entries to be selected.
     */
    starred: undefined,

    /**
     * Deleted state of entries to be selected. See constants in StorageInternal.
     */
    deleted: undefined,

    // For insertion search
    providedID: undefined,

    /**
     * Entry URL for bookmark comparison purposes
     */
    entryURL: undefined,

    /**
     * String that must be contained by title, content, authors or tags of the
     * selected entries.
     */
    searchString: undefined,

    /**
     * Date range for the selected entries.
     */
    startDate: undefined,
    endDate: undefined,

    /**
     * Maximum number of entries to be selected.
     */
    limit: undefined,

    /**
     * Specifies how many result entries to skip at the beggining of the result set.
     */
    offset: 0,

    /**
     * Direction in which to sort the results (order is always 'date').
     */
    sortDirection: 'desc',

    /**
     * Include hidden feeds i.e. the ones whose Live Bookmarks are no longer
     * to be found in Brief's home folder. This attribute is ignored if
     * the list of feeds is explicitly specified by Query.feeds.
     */
    includeHiddenFeeds: false,

     /**
     * Include feeds that the user marked as excluded from global views.
     */
    includeFeedsExcludedFromGlobalViews: true,

    async count() {
        let filters = this._filters();

        if(filters.sort.offset || filters.sort.limit) {
            throw "offset/limit are not supported for count queries";
        }

        let {indexName, filterFunction, ranges} = this._searchEngine(filters);

        let answer = 0;
        let totalCallbacks = 0;
        let tx = Database.db().transaction(['entries'], 'readonly');
        let store = tx.objectStore('entries');
        let index = indexName ? store.index(indexName) : store;
        Comm.verbose && console.log('Query.count(...)');
        if(filterFunction !== undefined) {
            console.warn("DB count with filter(s):", this);
        }
        if(filterFunction) {
            let cursors = ranges.map(r => index.openCursor(r));
            cursors.forEach(c => {
                c.onsuccess = ({target}) => {
                    let cursor = target.result;
                    if(cursor) {
                        totalCallbacks += 1;
                        if(filterFunction(cursor.value)) {
                            answer += 1;
                        }
                        cursor.continue();
                    }
                };
            });
            await DbUtil.transactionPromise(tx);
            console.log(`Brief: count with ${totalCallbacks} callbacks due to`, filters);
        } else {
            let requests = ranges.map(r => index.count(r));
            let promises = requests.map(r => DbUtil.requestPromise(r));
            let counts = await Promise.all(promises);
            answer = counts.reduce((a, b) => a + b, 0);
        }
        return answer;
    },

    async getIds() {
        return await this._getMap(e => e.id);
    },

    async getValuesOf(name) {
        return await this._getMap(e => e[name]);
    },

    async getEntries() {
        return await this._getMap((e, tx) => {
            for(let r of e.revisions) {
                let query = tx.objectStore('revisions').get(r.id);
                query.onsuccess = ({target}) => {
                    Object.assign(r, target.result);
                };
            }
            return e;
        }, ['entries', 'revisions']);
    },

    async _getMap(extractor, stores) {
        if(stores === undefined) {
            stores = ['entries'];
        }
        let filters = this._filters();
        let {indexName, filterFunction, ranges, direction} = this._searchEngine(filters);
        let sortKey;
        if(direction === "prev") {
            sortKey = (e => -e.date);
        } else {
            sortKey = (e => e.date);
        }
        let offset = filters.sort.offset || 0;
        let limit = filters.sort.limit !== undefined ? filters.sort.limit : Number('Infinity');

        let tx = Database.db().transaction(stores, 'readonly');
        let store = tx.objectStore('entries');
        let index = indexName ? store.index(indexName) : store;

        let cursors = ranges.map(r => index.openCursor(r, direction));
        Comm.verbose && console.log('DB _getMap');
        let result = this._mergeAndCollect(
            {cursors, filterFunction, sortKey, offset, limit, extractor, tx});

        await DbUtil.transactionPromise(tx);

        return result;
    },

    /*async*/ _mergeAndCollect({cursors, filterFunction, sortKey, offset, limit, extractor, tx}) {
        let totalCallbacks = 0;
        extractor = extractor || (v => v);
        let queue = Array(cursors.length);
        let pending = cursors.length;
        let result = [];
        if(cursors.length === 0) {
            return result;
        }
        let inf = Number('Infinity');
        for(let [idx, cur] of cursors.entries()) {
            cur.onsuccess = ({target}) => {
                totalCallbacks += 1;
                let cursor = target.result;
                if(cursor) {
                    cursors[idx] = cursor;
                } else {
                    cursors[idx] = null;
                }
                pending -= 1;
                if(pending === 0) {
                    let keys = cursors.map(c => c !== null ? sortKey(c.value) : inf);
                    let next = keys.reduce(((min, cur, i, arr) => cur < arr[min] ? i : min), 0);
                    if(keys[next] !== inf && limit > 0) {
                        let value = cursors[next].value;
                        if(filterFunction === undefined || filterFunction(value)) {
                            if(offset > 0) {
                                offset -= 1;
                            } else {
                                limit -= 1;
                                result.push(extractor(value, tx));
                            }
                        }
                        pending += 1;
                        cursors[next].continue();
                    } else {
                        Comm.verbose && console.log(
                            '_mergeAndCollect total callbacks:', totalCallbacks);
                    }
                }
            };
        }
        return result; // This will be ready by the end of transaction
    },

    async markRead(state) {
        return await this._update({
            action: e => { e.read = state ? 1 : 0; },
            changes: {read: state},
        });
    },

    async markDeleted(state) {
        return await this._update({
            action: e => { e.deleted = state || 0; },
            changes: {deleted: state}
        });
    },

    async bookmark(state) {
        let entries = await this.getEntries();
        let actions = [];
        for(let entry of entries) {
            let promise = browser.bookmarks.search({url: entry.entryURL}).then(bookmarks => {
                if(state && bookmarks.length == 0) {
                    let revision = entry.revisions[entry.revisions.length - 1];
                    return browser.bookmarks.create({url: entry.entryURL, title: revision.title});
                } else if(!state && bookmarks.length > 0) {
                    return Promise.all(bookmarks.map(b =>
                        browser.bookmarks.remove(b.id)));
                } else {
                    // Database does not match bookmarks - correct database directly
                    return Database.query(entry.id)._update({
                        action: e => { e.starred = state ? 1 : 0; },
                        changes: { starred: state ? 1 : 0 },
                    });
                }
            });
            actions.push(promise);
        }
        await Promise.all(actions);
    },

    async _update({action, stores, changes, then, tx}) {
        if(stores === undefined) {
            stores = ['entries'];
        }
        let filters = this._filters();
        let {indexName, filterFunction, ranges} = this._searchEngine(filters);
        if(filters.sort.offset || filters.sort.limit) {
            // FIXME: offset/limit
            throw "_update does not support offset/limit!";
        }
        let offset = filters.sort.offset || 0;
        let limit = filters.sort.limit !== undefined ? filters.sort.limit : Number('Infinity');

        if(tx === undefined) {
            tx = Database.db().transaction(stores, 'readwrite');
        } else {
            //TODO: check the stores are available here
        }
        let store = tx.objectStore('entries');
        let index = indexName ? store.index(indexName) : store;

        let feeds = new Set();
        let entries = [];

        Comm.verbose && console.log('DB _update');
        let cursors = ranges.map(r => index.openCursor(r, "prev"));
        if(cursors.length === 0) {
            then && then({tx, feeds, entries});
            await DbUtil.transactionPromise(tx);
            return;
        }
        cursors.forEach(c => {
            c.onsuccess = ({target}) => {
                let cursor = target.result;
                if(cursor) {
                    let value = cursor.value;
                    if(filterFunction === undefined || filterFunction(value)) {
                        action(value, {tx});
                        feeds.add(value.feedID);
                        entries.push(value);
                        cursor.update(value);
                    }
                    cursor.continue();
                } else {
                    if(target.then) {
                        target.then({tx, feeds, entries});
                    }
                }
            };
        });
        cursors[cursors.length - 1].then = then;
        await DbUtil.transactionPromise(tx);
        if(changes) {
            //TODO: we're missing revision data here
            Comm.broadcast('entries-updated', {
                feeds: Array.from(feeds),
                entries: Array.from(entries),
                changes,
            });
        }
    },

    _filters() {
        let filters = {};

        // First let's combine all feed-only filters
        let {
            feeds,
            folders,
            includeHiddenFeeds,
            includeFeedsExcludedFromGlobalViews,
        } = this;
        let active_feeds = Database.feeds;
        // Folder list
        if(folders !== undefined) {
            active_feeds = Database._includeChildren(folders);
        }
        // Feed list
        if(feeds !== undefined) {
            feeds = asArray(feeds);
            active_feeds = active_feeds.filter(feed => feeds.includes(feed.feedID));
            includeHiddenFeeds = true; //TODO: nonorthogonality
        }
        // Include hidden feeds
        if(!includeHiddenFeeds) {
            active_feeds = active_feeds.filter(feed => !feed.hidden);
        }
        // Include hidden feeds
        if(!includeFeedsExcludedFromGlobalViews) {
            active_feeds = active_feeds.filter(feed => !feed.omitInUnread);
        }
        // Feeds done
        filters.feeds = active_feeds.map(feed => feed.feedID);

        // Entry-based filters
        filters.entry = {
            id: this.entries,
            providedID: this.providedID,
            read: this.read !== undefined ? +this.read : undefined,
            starred: this.starred,
            deleted: this.deleted === false ? 0 : this.deleted,
            tags: this.tags,
            entryURL: this.entryURL,
            feedID: filters.feeds,
        };
        filters.fullTextSearch = this.searchString;

        // Sorting and limiting...
        let sortOrder = this.sortOrder;
        if(sortOrder !== undefined && sortOrder !== 'date') {
            throw `Invalid sort order: ${sortOrder}`
        }
        if((this.startDate || this.endDate) && sortOrder !== 'date') {
            if(sortOrder === undefined) {
                sortOrder = 'date';
            } else {
                console.trace();
                throw 'cannot filter on date when not sorting on date';
            }
        }
        filters.sort = {
            field: sortOrder,
            direction: this.sortDirection,
            limit: this.limit,
            offset: this.offset,
            start: this.startDate,
            end: this.endDate,
        };

        return filters;
    },

    // Brief-specific heuristics
    _guessIndexToUse({filters}) {
        // TODO: anything better than these heuristics?
        if(filters.entry.id !== undefined) {
            return 'id'; // Will be decoded to "no index, use primary key"
        }

        // Search by [feedID, entryURL] during insertion
        if(filters.entry.entryURL && filters.feeds && filters.feeds.length === 1) {
            return ['feedID', 'entryURL'];
        }

        // Search by [feedID, providedID] during insertion
        if(filters.entry.providedID && filters.feeds && filters.feeds.length === 1) {
            return ['feedID', 'providedID'];
        }

        // Search by [entryURL] for starring
        if(filters.entry.entryURL) {
            return 'entryURL';
        }
        return ['deleted', 'starred', 'read', 'feedID', 'date']; // Hardcoded default
    },

    // Brief-specific data
    _possibleValues(field) {
        switch(field) {
            case 'deleted': return [0, 'trashed', 'deleted'];
            case 'starred': return [0, 1];
            case 'read': return [0, 1];
            default: return;
        }
    },

    _directFilter({template, indexedFields}) {
        let reference = {};
        let callback = undefined;

        let primitiveFilter = entry => {
            for(let [k, v] of Object.entries(reference)) {
                if(!v.includes(entry[k])) {
                    return false;
                }
            }
            return true;
        }

        for(let [k, v] of Object.entries(template)) {
            if(v === undefined) { // Not a real filter criterion
                continue;
            }
            if(indexedFields.includes(k)) { // Ensured automatically by the bounds
                continue;
            }
            // Ok, we'll need to actually filter on it
            callback = primitiveFilter;
            if(Array.isArray(v)) {
                reference[k] = v;
            } else {
                reference[k] = [v];
            }
        }
        return callback;
    },

    _searchEngine(filters) {
        let indexPath = this._guessIndexToUse({filters});
        let unwrap;
        if(Array.isArray(indexPath)) {
            unwrap = false;
        } else {
            indexPath = [indexPath];
            unwrap = true;
        }

        let direction = "prev";
        if(filters.sort.direction === 'asc') {
            direction = "next";
        }

        let indexName = indexPath.join('_');
        if(indexName === 'id') {
            indexName = null;
        }

        // What fields off the index we can use at all?
        let optionSets = indexPath.map(name => ({name, values: filters.entry[name]}));
        while(optionSets.length && optionSets[optionSets.length - 1].values === undefined) {
            let set = optionSets[optionSets.length - 1];
            if(set.name === filters.sort.field) {
                set.range = [filters.sort.start, filters.sort.end];
                break;
            }
            optionSets.pop();
        }
        let valueSets = optionSets.map(({name, values}) => {
            return (values !== undefined) ? values : this._possibleValues(name);
        });

        // Build the ranges for cursors
        let indexedFields = [];
        let prefixes = [[]];
        let rangeOptions = {unwrap, min: undefined, max: undefined};
        for(let {name, range, values} of optionSets) {
            indexedFields.push(name);
            if(range) {
                rangeOptions.min = range[0];
                rangeOptions.max = range[1];
                break;
            } else {
                prefixes = this._expandPrefixes(prefixes, values, this._possibleValues(name));
            }
        }
        let ranges = this._prefixesToRanges(prefixes, rangeOptions);

        if(filters.sort.field && !indexedFields.includes(filters.sort.field)) {
            throw "The sort field MUST be index-based!";
        }

        // Filter on everything an index cannot get
        let filterFunction = this._directFilter({template: filters.entry, indexedFields});
        return {indexName, filterFunction, ranges, direction};
    },

    _expandPrefixes(prefixes, requirement, possibleValues) {
        if(requirement === undefined) {
            requirement = possibleValues;
        }
        if(requirement === undefined) {
            throw "cannot expand prefixes without requirement and possibleValues"
        }
        if(requirement === false) {
            requirement = 0;
        } else if(requirement === true) {
            requirement = 1;
        }
        if(!Array.isArray(requirement)) {
            requirement = [requirement];
        }
        let newPrefixes = [];
        for(let old of prefixes) {
            for(let value of requirement) {
                newPrefixes.push(Array.concat(old, [value]));
            }
        }
        return newPrefixes;
    },

    _prefixesToRanges(prefixes, {unwrap, min, max}) {
        return prefixes.map(prefix => {
            if(unwrap) {
                if(prefix.length) {
                    return prefix[0];
                } else {
                    return IDBKeyRange.bound(min, max);
                }
            }
            let lower = prefix;
            if(min !== undefined) {
                lower = Array.concat(prefix, [min])
            }
            let bound = [];
            if(max !== undefined) {
                bound = max;
            }
            let upper = Array.concat(prefix, [bound]);
            if(lower.length === 0) {
                lower = Number('-Infinity');
            }
            return IDBKeyRange.bound(lower, upper);
        });
    },

    _ftsMatches(entry, string) {
        return true;//TODO: restore FTS
    },
};

const DbUtil = {
    // Note: this is resolved after the transaction is finished(!!!) mb1193394
    requestPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = (event) => resolve(event.target.result);
            req.onerror = (event) => reject(event.target.error);
        });
    },

    // Note: this is resolved after the transaction is finished(!)
    transactionPromise(tx) {
        return new Promise((resolve, reject) => {
            let oncomplete = tx.oncomplete;
            let onerror = tx.onerror;
            tx.oncomplete = () => { resolve(); if(oncomplete) oncomplete(); };
            tx.onerror = () => { reject(); if(onerror) onerror(); };
        });
    },
};
