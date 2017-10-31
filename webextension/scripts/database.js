'use strict';

let Feeds = {
    _watchFeedList: null,

    async init() {
        this._watchFeedList = browser.runtime.connect({name: 'watch-feed-list'});
        this._watchFeedList.onMessage.addListener(feeds => this._updateFeeds(feeds));
    },

    _updateFeeds(feeds) {
        for(let feed of feeds) {
            for(let key of Object.getOwnPropertyNames(feed)) {
                if(key === 'favicon')
                    delete feed.favicon;
                if(feed[key] === null)
                    delete feed[key];
            }
        }
        browser.storage.local.set({feeds});
        browser.storage.sync.set({feeds}); // Fx53+, fails with console error on 52
        console.debug(`updated ${feeds.length} feeds`);
    },
};

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
let Entries = {
    _db: null,
    _watchChanges: null,

    init() {
        browser.tabs.create({url: 'test.html'});
        this._watchChanges = browser.runtime.connect({name: 'watch-entry-changes'});
        this._watchChanges.onMessage.addListener(change => this._applyChange(change));
        let opener = indexedDB.open("brief", {version: 10, storage: "temporary"});
        opener.onupgradeneeded = (event) => this.upgrade(event);
        opener.onsuccess = (event) => {
            this._db = event.target.result;
            this.fetchAllEntries();
        };
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
        }
    },

    ENTRY_FIELDS: [
        'id', 'feedID',
        'read', 'markedUnreadOnUpdate', 'starred', 'tags', 'deleted',
        'providedID', 'entryURL', 'primaryHash', 'secondaryHash',
        'date',
    ],
    REVISION_FIELDS: ['id', 'authors', 'title', 'content', 'updated'],

    storeEntry(origEntry, transaction) {
        let resolve, reject;
        let promise = new Promise((resolve_, reject_) => {
            resolve = resolve_;
            reject = reject_;
        });
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

        if(this._db === null) {
            return;
        }

        let tx;
        if(transaction !== undefined) {
            tx = transaction;
        } else {
            tx = this._db.transaction(['revisions', 'entries'], 'readwrite');
        }
        tx.objectStore('revisions').put(revision);
        tx.objectStore('entries').put(entry);
        if(transaction === undefined) {
            tx.oncomplete = resolve;
        } else {
            resolve();
        }
        return promise;
    },

    storeEntries(entries) {
        return new Promise((resolve, reject) => {
            console.log(`inserting ${entries.length} entries...`);
            let tx = this._db.transaction(['revisions', 'entries'], 'readwrite');
            let last = undefined;
            for(let entry of entries) {
                last = this.storeEntry(entry, tx);
            }
            tx.oncomplete = () => {
                console.log('inserting done');
                resolve();
            };
        });
    },

    async fetchAllEntries() {
        console.log("fetching ALL entry IDs...");
        let ids = await browser.runtime.sendMessage({
            id: 'query-entries',
            query: {
                includeHiddenFeeds: true,
            },
            mode: 'id',
        });
        console.log(`fetched ${ids.length} entry IDs...`);

        // TODO: remove already existing IDs

        while(ids.length > 0) {
            let current_ids = ids.splice(0, 900);
            console.log(`fetching ${current_ids.length} entries...`);
            let entries = await browser.runtime.sendMessage({
                id: 'query-entries',
                query: {
                    includeHiddenFeeds: true,
                    entries: current_ids,
                },
            });
            await this.storeEntries(entries);
        }
        console.log("done.");
    },

    _applyChange(change) {
        console.log("received change: ", change);
    },
};
