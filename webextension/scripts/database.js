'use strict';

// Adapt setTimeout for Promises
function timeout(delay) {
    return new Promise(resolve => setTimeout(resolve, delay));
}


/**
 * Database design and considerations
 *
 * 1. Revision table.
 * Item content, as fetched from the server, is stored as a `revision`.
 * Revisions are immutable. For now there's only one revision per entry,
 * but this may change in the future. For the migration period their IDs
 * match the sqlite entry IDs.
 *
 * 2. Entry table.
 * An entry is an item from a feed. For the migration period their IDs
 * match the sqlite entry IDs.
 */
// IndexedDB does not play nice with `async` (transaction ends before execution restarts)
// and the same problem with native Promise
// mb1193394, worked on around Fx58 nightly
let Database = {
    _db: null,

    async init() {
        await browser.runtime.sendMessage(
            {id: 'allow-unlimited-storage', url: browser.runtime.getURL('/')});
        let opener = indexedDB.open("brief", {version: 20, storage: "persistent"});
        opener.onupgradeneeded = (event) => this.upgrade(event);
        let request = await Promise.race([
            this._requestPromise(opener),
            timeout(15000),
        ]);
        let storage;
        if(request === undefined) {
            console.warn("Failed to open the persistent DB, opening default one");
            opener = indexedDB.open("brief", {version: 20});
            opener.onupgradeneeded = (event) => this.upgrade(event);
            request = await this._requestPromise(opener);
            storage = "default";
        } else {
            storage = "persistent";
        }
        await browser.storage.local.set({storage});
        this._db = request.result;
    },

    upgrade(event) {
        console.log(`upgrade from version ${event.oldVersion}`);
        let db = event.target.result;
        switch(event.oldVersion) {
            case 0:
                let revisions = db.createObjectStore("revisions", {
                    keyPath: "id", autoIncrement: true});
                // There could be a full-text index here, but let's avoid this
                let entries = db.createObjectStore("entries", {
                    keyPath: "id", autoIncrement: true});
                entries.createIndex("date", "date");
                entries.createIndex("feedID_date", ["feedID", "date"]);
                entries.createIndex("primaryHash", "primaryHash");
                entries.createIndex("bookmarkID", "bookmarkID");
                entries.createIndex("entryURL", "entryURL");
                entries.createIndex("tagName", "tags", {multiEntry: true});
            // fallthrough
            case 10:
                let feeds = db.createObjectStore("feeds", {
                    keyPath: "feedID", autoIncrement: true});
                // No indices needed - the feed list is always loaded to memory
        }
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
        entry.bookmarked = (origEntry.bookmarkID !== -1);
        entry.tags = (entry.tags || '').split(', ');

        tx.objectStore('revisions').put(revision);
        tx.objectStore('entries').put(entry);
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

    async deleteEntries(entries) {
        console.log(`Deleting ${entries.length} entries`);
        let tx = this._db.transaction(['revisions', 'entries'], 'readwrite');
        for(let entry of entries) {
            tx.objectStore('revisions').delete(entry);
            tx.objectStore('entries').delete(entry);
        }
        await this._transactionPromise(tx);
        console.log(`${entries.length} entries deleted`);
    },

    async clearEntries() {
        console.log(`Clearing the entries database`);
        let tx = this._db.transaction(['revisions', 'entries'], 'readwrite');
        tx.objectStore('revisions').clear();
        tx.objectStore('entries').clear();
        await this._transactionPromise(tx);
        console.log(`Databases cleared`);
    },

    async listEntries() {
        let tx = this._db.transaction(['entries']);
        let request = tx.objectStore('entries').getAllKeys();
        return (await this._requestPromise(request)).result;
    },

    async saveFeeds(feeds) {
        if(this._db === null) {
            return;
        }
        let tx = this._db.transaction(['feeds'], 'readwrite');
        for(let feed of feeds) {
            tx.objectStore('feeds').put(feed);
        }
        await this._transactionPromise(tx);
    },

    // Note: this is resolved after the transaction is finished(!!!) mb1193394
    _requestPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = (event) => resolve(event.target);
            req.onerror = (event) => reject(event.target);
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


let FeedSyncer = {
    _watchFeedList: null,

    async init() {
        this._watchFeedList = browser.runtime.connect({name: 'watch-feed-list'});
        this._watchFeedList.onMessage.addListener(feeds => this._saveFeeds(feeds));
    },

    async _saveFeeds(feeds) {
        for(let feed of feeds) {
            for(let key of Object.getOwnPropertyNames(feed)) {
                if(key === 'favicon')
                    delete feed.favicon;
                if(feed[key] === null)
                    delete feed[key];
            }
        }
        let store_local = browser.storage.local.set({feeds});
        let store_sync = browser.storage.sync.set({feeds}); // Fx53+, fails with console error on 52
        let store_db = Database.saveFeeds(feeds); // May be a nop if not ready
        await Promise.all([store_local, store_sync, store_db]);
        console.debug(`Saved feed list with ${feeds.length} feeds`);
    },
};


let EntrySyncer = {
    _watchChanges: null,

    async init() {
        this._watchChanges = browser.runtime.connect({name: 'watch-entry-changes'});
        this._watchChanges.onMessage.addListener(change => this._applyChange(change));

        this._initialSync(); // Don't wait for it, however
    },

    async _initialSync() {
        let lastVersion = Prefs.get('lastVersion');
        const MIGRATED = 'webextension-migration-done';
        if(lastVersion !== MIGRATED) {
            console.warn(`Downgrade to ${lastVersion} detected, IndexedDB may be wrong!`);
            await Database.clearEntries();
            await Prefs.set('lastVersion', MIGRATED);
            console.log("IndexedDB cleared, re-syncing from scratch");
        }
        console.log("Starting initial sync");
        let legacy_ids = await this._listLegacyEntries();
        let idb_ids = await Database.listEntries();
        await this._purgeStaleEntries(legacy_ids, idb_ids);
        await this._syncMissingEntries(legacy_ids, idb_ids);
    },


    async _purgeStaleEntries(legacy_ids, idb_ids) {
        console.log("Purge triggered");
        if(legacy_ids === undefined) {
            legacy_ids = await this._listLegacyEntries();
        }
        if(idb_ids === undefined) {
            idb_ids = await Database.listEntries();
        }

        legacy_ids = new Set(legacy_ids);
        let purge_ids = idb_ids.filter(id => !legacy_ids.has(id));

        console.log(`Found ${purge_ids.length} stale entries`);

        await Database.deleteEntries(purge_ids);
    },

    async _syncMissingEntries(legacy_ids, idb_ids) {
        console.log("Sync missing triggered");
        if(legacy_ids === undefined) {
            legacy_ids = await this._listLegacyEntries();
        }
        if(idb_ids === undefined) {
            idb_ids = await Database.listEntries();
        }

        legacy_ids.reverse();
        idb_ids = new Set(idb_ids);
        let missing_ids = legacy_ids.filter(id => !idb_ids.has(id));

        console.log(`Found ${missing_ids.length} missing entries`);

        await this._fetchAndStore(missing_ids);
    },

    async _listLegacyEntries() {
        console.log("Listing legacy IDs...");
        let legacy_ids = await browser.runtime.sendMessage({
            id: 'query-entries',
            query: {
                includeHiddenFeeds: true,
            },
            mode: 'id',
        });
        console.log(`Found ${legacy_ids.length} entry IDs in legacy`);
        return legacy_ids;
    },

    async _fetchAndStore(ids) {
        while(ids.length > 0) {
            let current_ids = ids.splice(0, 900);
            console.log(`Fetching ${current_ids.length} entries`);
            let entries = await browser.runtime.sendMessage({
                id: 'query-entries',
                query: {
                    includeHiddenFeeds: true,
                    entries: current_ids,
                },
            });
            await Database.putEntries(entries);
        }
        console.log("Done syncing down entries");
    },

    _applyChange(change) {
        let {action, entries} = change;
        console.log("received change: ", change);
        if(action === 'update') {
            this._fetchAndStore(entries);
        } else if(action === 'purge') {
            this._purgeStaleEntries();
        }
    },
};
