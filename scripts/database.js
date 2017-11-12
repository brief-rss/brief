'use strict';


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
            wait(15000),
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

    query(filters) {
        if(filters === undefined) {
            filters = {};
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


function Query(filters) {
    for(let name in filters)
        this[name] = filters[name];
};

Query.prototype = {
    async count() {
    },
};
