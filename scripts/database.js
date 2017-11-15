'use strict';


/**
 * Database design and considerations
 *
 * 1. Revision table.
 * Item content, as fetched from the server, is stored as a `revision`.
 * Revisions are immutable. For now there's only one revision per entry,
 * but this may change in the future.
 *
 * 2. Entry table.
 * An entry is an item from a feed.
 */
// IndexedDB does not play nice with `async` (transaction ends before execution restarts)
// and the same problem with native Promise
// mb1193394, worked on around Fx58 nightly
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
        return this.feeds.filter(f => f.feedID === feedID)[0];
    },

    async init() {
        if(this._db)
            return;
        let {storage} = await browser.storage.local.get({storage: 'persistent'});
        console.log(`Brief: opening database in ${storage} storage`);
        let openOptions = {version: this.DB_VERSION};
        if(storage === 'persistent') {
            openOptions.storage = 'persistent';
        }
        let opener = indexedDB.open("brief", openOptions);
        opener.onupgradeneeded = (event) => this._upgradeSchema(event);
        this._db = await this._requestPromise(opener);
        this.loadFeeds();
        let entryCount = await this.countEntries();
        console.log(`Brief: opened database with ${entryCount} entries`);
        Comm.registerObservers({
            'feedlist-updated': ({feeds}) => this._feeds = feeds, // Already saved elsewhere
            'feedlist-modify': ({updates}) => this.modifyFeed(updates),
            'feedlist-delete': ({feeds}) => this.deleteFeed(feeds),
        });
    },

    _upgradeSchema(event) {
        console.log(`upgrade from version ${event.oldVersion}`);
        let {result: db, transaction: tx} = event.target;
        let revisions;
        let entries;
        switch(event.oldVersion) {
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
        value._v = this.DB_VERSION;
        return value;
    },

    ENTRY_FIELDS: [
        'id', 'feedID',
        'read', 'markedUnreadOnUpdate', 'starred', 'tags', 'deleted',
        'providedID', 'entryURL', 'primaryHash', 'secondaryHash',
        'date',
    ],
    REVISION_FIELDS: ['id', 'authors', 'title', 'content', 'updated'],

    _putEntry(origEntry, tx) {
        let entry = {};
        let revision = {};

        for(let name of this.ENTRY_FIELDS) {
            entry[name] = origEntry[name];
        }
        entry.revisions = [{id: origEntry.id}]
        for(let name of this.REVISION_FIELDS) {
            revision[name] = origEntry[name];
        }
        delete entry.bookmarkID;
        entry.tags = (entry.tags || '').split(', ');

        tx.objectStore('revisions').put(revision);
        tx.objectStore('entries').put(entry);
    },

    query(filters) {
        if(!filters)
            return;

        if(typeof filters == 'number') {
            filters = {entries: [filters]};
        }
        else if (Array.isArray(filters)) {
            filters = {entries: filters};
        }

        return new Query(filters);
    },

    async putEntries(entries) {
        console.log(`Inserting ${entries.length} entries`);
        let tx = this._db.transaction(['revisions', 'entries'], 'readwrite');
        for(let entry of entries) {
            this._putEntry(entry, tx);
        }
        await this._transactionPromise(tx);
        console.log('Done inserting');
    },

    async countEntries() {
        let tx = this._db.transaction(['entries']);
        let request = tx.objectStore('entries').count();
        return await this._requestPromise(request);
    },

    async loadFeeds() {
        let tx = this._db.transaction(['feeds']);
        let request = tx.objectStore('feeds').getAll();
        let feeds = await this._requestPromise(request);
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
            this.saveFeeds();
        }

        feeds.sort((a, b) => a.rowIndex - b.rowIndex);
        this._feeds = feeds;
    },

    async saveFeeds() {
        if(this._db === null) {
            return;
        }
        let feeds = this.feeds;
        let tx = this._db.transaction(['feeds'], 'readwrite');
        tx.objectStore('feeds').clear();
        for(let feed of feeds) {
            tx.objectStore('feeds').put(feed);
        }
        await this._transactionPromise(tx);
        await this._saveFeedBackups(feeds);
        console.log(`Brief: saved feed list with ${feeds.length} feeds`);
        Comm.broadcast('feedlist-updated', {feeds});
    },

    async modifyFeed(props) {
        if(!Comm.master) {
            return Comm.callMaster('feedlist-modify', {updates: props});
        }
        props = Array.isArray(props) ? props : [props];
        for(let bag of props) {
            let feed = this.getFeed(bag.feedID);
            for(let [k, v] of Object.entries(bag)) {
                if(feed[k] !== undefined && feed[k] === v) {
                    continue;
                }
                feed[k] = v;
                //TODO: expire entries
            }
        }
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

    // Note: this is resolved after the transaction is finished(!!!) mb1193394
    _requestPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = (event) => resolve(event.target.result);
            req.onerror = (event) => reject(event.target.error);
        });
    },

    // Note: this is resolved after the transaction is finished(!)
    _transactionPromise(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = reject;
        });
    },
};
//TODO: database cleanup
//FIXME: bookmark to starred sync


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
            await Database._transactionPromise(tx);
            console.log(`Brief: count with ${totalCallbacks} callbacks due to`, filters);
        } else {
            let requests = ranges.map(r => index.count(r));
            let promises = requests.map(r => Database._requestPromise(r));
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
        let result = this._mergeAndCollect(
            {cursors, filterFunction, sortKey, offset, limit, extractor, tx});

        await Database._transactionPromise(tx);

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
                    }
                }
            };
        }
        return result; // This will be ready by the end of transaction
    },

    async markRead(state) {
        return await this._update({
            action: e => { e.read = state ? 1 : 0; },
            notify: {read: state},
        });
    },

    async markDeleted(state) {
        return await this._update({
            action: e => { e.deleted = state || 0; },
            notify: {deleted: state}
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
                }
                if(!state && bookmarks.length > 0) {
                    return Promise.all(bookmarks.map(b =>
                        browser.bookmarks.remove(b.id)));
                }
            });
            actions.push(promise);
        }
        await Promise.all(actions);
    },

    async syncStarredFromBookmarks() {
        let entries = await this.getEntries();
        let groups = await Promise.all(entries.map(
                entry => browser.bookmarks.search({url: entry.entryURL})
                    .then(bookmarks => {entry, bookmarks})
        ));
        let star = new Set();
        let unstar = new Set();
        for(let {entry, bookmarks} of groups) {
            let starred = (bookmarks.length > 0) ? 1 : 0;
            if(starred && !entry.starred) {
                star.add(entry.id);
            } else if (!starred && entry.starred) {
                unstar.add(entry.id);
            }
        }
        Database.query(Array.from(star))._update({
            action: entry => { entry.star = 1; },
            notify: {star: 1},
        });
        Database.query(Array.from(unstar))._update({
            action: entry => { entry.star = 0; },
            notify: {star: 0},
        });
    },

    async _update({action, stores, notify}) {
        notify = notify || {};
        if(stores === undefined) {
            stores = ['entries'];
        }
        let filters = this._filters();
        let {indexName, filterFunction, ranges} = this._searchEngine(filters);
        let offset = filters.sort.offset || 0;
        let limit = filters.sort.limit !== undefined ? filters.sort.limit : Number('Infinity');

        let tx = Database.db().transaction(stores, 'readwrite');
        let store = tx.objectStore('entries');
        let index = indexName ? store.index(indexName) : store;

        let feeds = new Set();
        let entries = [];

        let cursors = ranges.map(r => index.openCursor(r, "prev"));
        cursors.forEach(c => {
            c.onsuccess = ({target}) => {
                let cursor = target.result;
                if(cursor) {
                    let value = cursor.value;
                    action(value);
                    feeds.add(value.feedID);
                    entries.push(value);
                    cursor.update(value);
                    cursor.continue();
                }
            };
        });
        await Database._transactionPromise(tx);
        Comm.broadcast('entries-updated', {
            feeds: Array.from(feeds),
            entries: Array.from(entries),
            changes: notify,
        });
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
            read: this.read !== undefined ? +this.read : undefined,
            starred: this.starred,
            deleted: this.deleted === false ? 0 : this.deleted,
            tags: this.tags,
        };
        filters.fullTextSearch = this.searchString;

        // Sorting and limiting...
        if(this.sortOrder !== undefined && this.sortOrder !== 'date') {
            throw `Invalid sort order: ${this.sortOrder}`
        }
        filters.sort = {
            direction: this.sortDirection,
            limit: this.limit,
            offset: this.offset,
            start: this.startDate,
            end: this.endDate,
        };

        return filters;
    },

    _searchEngine(filters) {
        // And now
        let indexName = 'deleted_starred_read_feedID_date'; // TODO: hardcoded
        let direction = "prev";
        if(filters.sort.direction === 'asc') {
            direction = "next";
        }

        let filterFunction = entry => {
            return (true
                && (filters.entry.tags === undefined || filters.entry.tags.some(tag => entry.tags.includes(tag)))
                && (filters.fullTextSearch === undefined || this._ftsMatches(entry, filters.fullTextSearch))
            );
        };

        let prefixes = [[]];
        // Extract the common prefixes
        prefixes = this._expandPrefixes(prefixes, filters.entry.deleted, [0, 'trashed', 'deleted']);
        prefixes = this._expandPrefixes(prefixes, filters.entry.starred, [0, 1]);
        prefixes = this._expandPrefixes(prefixes, filters.entry.read, [0, 1]);
        prefixes = this._expandPrefixes(prefixes, filters.feeds); // Always present

        let ranges = this._prefixesToRanges(prefixes,
            {min: filters.sort.start, max: filters.sort.end});

        if(filters.entry.id !== undefined) {
            indexName = null;
            filterFunction = undefined;
            ranges = filters.entry.id;
            // TODO: entries should not ignore other filters; not critical (not used with both)
        }

        if(filters.entry.tags === undefined &&
            filters.fullTextSearch === undefined) {
            filterFunction = undefined;
        }

        return {indexName, filterFunction, ranges, direction};
    },

    _expandPrefixes(prefixes, requirement, possibleValues) {
        if(requirement === undefined) {
            requirement = possibleValues;
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

    _prefixesToRanges(prefixes, {min, max}) {
        return prefixes.map(prefix => {
            let lower = prefix;
            if(min !== undefined) {
                lower = Array.concat(prefix, [min])
            }
            let bound = [];
            if(max !== undefined) {
                bound = max;
            }
            let upper = Array.concat(prefix, [bound]);
            return IDBKeyRange.bound(lower, upper);
        });
    },

    _ftsMatches(entry, string) {
        return true;//TODO: restore FTS
    },
};
