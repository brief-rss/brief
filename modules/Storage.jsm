const EXPORTED_SYMBOLS = ['Storage', 'Query'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/StorageUtils.jsm');
Components.utils.import('resource://brief/FeedContainer.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/FileUtils.jsm');

IMPORT_COMMON(this);


const PURGE_ENTRIES_INTERVAL = 3600*24; // 1 day
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // 1 week
const LIVEMARKS_SYNC_DELAY = 100;
const BACKUP_FILE_EXPIRATION_AGE = 3600*24*14; // 2 weeks
const DATABASE_VERSION = 17;
const DATABASE_CACHE_SIZE = 256; // With the default page size of 32KB, it gives us 8MB of cache memory.

const FEEDS_TABLE_SCHEMA = [
    'feedID          TEXT UNIQUE',
    'feedURL         TEXT',
    'websiteURL      TEXT',
    'title           TEXT',
    'subtitle        TEXT',
    'favicon         TEXT',
    'bookmarkID      TEXT',
    'parent          TEXT',
    'rowIndex        INTEGER',
    'isFolder        INTEGER',
    'hidden          INTEGER DEFAULT 0',
    'lastUpdated     INTEGER DEFAULT 0',
    'oldestEntryDate INTEGER',
    'entryAgeLimit   INTEGER DEFAULT 0',
    'maxEntries      INTEGER DEFAULT 0',
    'updateInterval  INTEGER DEFAULT 0',
    'dateModified    INTEGER DEFAULT 0',
    'lastFaviconRefresh INTEGER DEFAULT 0',
    'markModifiedEntriesUnread INTEGER DEFAULT 1',
    'omitInUnread     INTEGER DEFAULT 0'
]

const ENTRIES_TABLE_SCHEMA = [
    'id            INTEGER PRIMARY KEY AUTOINCREMENT',
    'feedID        TEXT',
    'primaryHash   TEXT',
    'secondaryHash TEXT',
    'providedID    TEXT',
    'entryURL      TEXT',
    'date          INTEGER', // Time.
    'updated       INTEGER', // Time.
    'read          INTEGER DEFAULT 0',  // Multi-state flag. 0 - unread, 1 - read,
                                        // 2 - re-marked unread after entry was updated.
    'starred       INTEGER DEFAULT 0',  // Boolean flag.
    'deleted       INTEGER DEFAULT 0',  // Boolean flag.
    'bookmarkID    INTEGER DEFAULT -1 ' // Numeric ID.
]

const ENTRIES_TEXT_TABLE_SCHEMA = [
    'title   TEXT ',
    'content TEXT ',
    'authors TEXT ',
    'tags    TEXT '
]

const ENTRY_TAGS_TABLE_SCHEMA = [
    'tagName  TEXT    ',
    'entryID  INTEGER '
]

const REASON_FINISHED = Ci.mozIStorageStatementCallback.REASON_FINISHED;
const REASON_ERROR = Ci.mozIStorageStatementCallback.REASON_ERROR;

XPCOMUtils.defineLazyServiceGetter(this, 'Bookmarks', '@mozilla.org/browser/nav-bookmarks-service;1', 'nsINavBookmarksService');

XPCOMUtils.defineLazyGetter(this, 'Prefs', function() {
    return Services.prefs.getBranch('extensions.brief.');
})
XPCOMUtils.defineLazyGetter(this, 'Places', function() {
    Components.utils.import('resource://gre/modules/PlacesUtils.jsm');
    return PlacesUtils;
})


let Connection = null;

function Statement(aStatement, aDefaultParams) {
    StorageStatement.call(this, Connection, aStatement, aDefaultParams);
}

Statement.prototype = StorageStatement.prototype;


// Exported object exposing public properties.
const Storage = Object.freeze({

    ENTRY_STATE_NORMAL: 0,
    ENTRY_STATE_TRASHED: 1,
    ENTRY_STATE_DELETED: 2,

    /**
     * Returns a feed or a folder with given ID.
     *
     * @param aFeedID
     * @returns Feed object, without entries.
     */
    getFeed: function(aFeedID) {
        return StorageInternal.getFeed(aFeedID);
    },

    /**
     * Gets all feeds, without entries.
     *
     * @param aIncludeFolders [optional]
     * @param aIncludeInactive [optional]
     * @returns array of Feed objects.
     */
    getAllFeeds: function(aIncludeFolders, aIncludeInactive) {
        return StorageInternal.getAllFeeds(aIncludeFolders, aIncludeInactive);
    },

    /**
     * Gets a list of distinct tags for URLs of entries stored in the database.
     *
     * @param aCallback
     *        Receives an array of strings of tag names.
     */
    getAllTags: function(aCallback) {
        return StorageInternal.getAllTags(aCallback);
    },

    /**
     * Updates feed properties and inserts/updates entries.
     *
     * @param aFeed
     *        Feed object containing the current feed's properties.
     * @param aEntries
     *        Array of Entry objects to process.
     * @param aCallback
     */
    processFeed: function(aFeed, aEntries, aCallback) {
        return StorageInternal.processFeed(aFeed, aEntries, aCallback);
    },

    /**
     * Updates feed properties and settings.
     *
     * @param aPropertyBags
     *        An object or an array of objects containing a feedID property and name-value
     *        pairs of properties to update. Invalid properties are ignored.
     * @param aCallback [optional]
     */
    changeFeedProperties: function(aPropertyBags, aCallback) {
        return StorageInternal.changeFeedProperties(aPropertyBags, aCallback);
    },

    /**
     * Synchronizes database with Live Bookmarks from home folder which ID is
     * specified by extensions.brief.homeFolder.
     * Feeds that were removed from the home folder remain in the database in the hidden
     * state for a certain amount of time in case they are added back.
     */
    syncWithLivemarks: function() {
        return StorageInternal.syncWithLivemarks();
    },

    /**
     * Registers an object to be notified of changes to feed entries. A strong reference
     * is held to this object, so all observers have to be removed using
     * Storage.removeObserver().
     *
     * An observer may implement any of the following functions:
     *
     *     function onEntriesAdded(aEntryList)
     *
     * Called when new entries are added to the database.
     *
     *     function onEntriesUpdated(aEntryList);
     *
     * Called when properties of existing entries - such as title, content, authors
     * and date - are changed. When entries are updated, they can also be marked as unread.
     *
     *     function onEntriesMarkedRead(aEntryList, aNewState);
     *
     * Called when the read/unread state of entries changes.
     *
     *     function onEntriesStarred(aEntryList, aNewState);
     *
     * Called when URLs of entries are bookmarked/unbookmarked.
     *
     *     function onEntriesTagged(aEntryList, aNewState, aTagName);
     *
     * Called when a tag is added or removed from entries.
     *
     *     function onEntriesDeleted(aEntryList, aNewState);
     *
     * Called when the deleted state of entries changes.
     */
    addObserver: function(aObserver) {
        return StorageInternal.addObserver(aObserver);
    },

    /**
     * Unregisters an observer object.
     */
    removeObserver: function(aObserver) {
        return StorageInternal.removeObserver(aObserver);
    }

})


let StorageInternal = {

    allItemsCache:    null,
    activeItemsCache: null,
    activeFeedsCache: null,

    init: function StorageInternal_init() {
        let databaseFile = FileUtils.getFile('ProfD', ['brief.sqlite']);
        let databaseIsNew = !databaseFile.exists();

        Connection = new StorageConnection(databaseFile, false);
        let schemaVersion = Connection.schemaVersion;

        // Remove the backup file after certain amount of time.
        let backupFilename = 'brief-backup-' + (schemaVersion - 1) + '.sqlite';
        let backupFile = FileUtils.getFile('ProfD', [backupFilename]);
        if (backupFile.exists() && Date.now() - backupFile.lastModifiedTime > BACKUP_FILE_EXPIRATION_AGE)
            backupFile.remove(false);

        if (!Connection.connectionReady) {
            // The database was corrupted, back it up and create a new one.
            Services.storage.backupDatabaseFile(databaseFile, 'brief-backup.sqlite');
            Connection.close();
            databaseFile.remove(false);
            Connection = new StorageConnection(databaseFile, false);
            this.setupDatabase();
        }
        else if (databaseIsNew) {
            this.setupDatabase();
        }
        else if (schemaVersion < DATABASE_VERSION) {
            // Remove the old backup file.
            if (backupFile.exists())
                backupFile.remove(false);

            // Backup the database before migration.
            let filename = 'brief-backup-' + schemaVersion + '.sqlite';
            Services.storage.backupDatabaseFile(databaseFile, filename);

            // No support for migration from versions older than 1.2,
            // create a new database.
            if (schemaVersion < 9) {
                Connection.close();
                databaseFile.remove(false);
                Connection = new StorageConnection(databaseFile, false);
                this.setupDatabase();
            }
            else {
                this.upgradeDatabase();
            }
        }

        Connection.executeSQL('PRAGMA cache_size = ' + DATABASE_CACHE_SIZE);

        this.refreshFeedsCache();

        this.homeFolderID = Prefs.getIntPref('homeFolder');
        Prefs.addObserver('', this, false);

        Services.obs.addObserver(this, 'quit-application', false);
        Services.obs.addObserver(this, 'idle-daily', false);

        // This has to be on the end, in case getting bookmarks service throws.
        Bookmarks.addObserver(BookmarkObserver, false);
    },

    setupDatabase: function Database_setupDatabase() {
        Connection.executeSQL(
            'CREATE TABLE IF NOT EXISTS feeds (' + FEEDS_TABLE_SCHEMA.join(',') + ') ',
            'CREATE TABLE IF NOT EXISTS entries (' + ENTRIES_TABLE_SCHEMA.join(',') + ') ',
            'CREATE TABLE IF NOT EXISTS entry_tags (' + ENTRY_TAGS_TABLE_SCHEMA.join(',') + ') ',
            'CREATE VIRTUAL TABLE entries_text USING fts3 (' + ENTRIES_TEXT_TABLE_SCHEMA.join(',') + ')',

            'CREATE INDEX IF NOT EXISTS entries_date_index ON entries (date)                ',
            'CREATE INDEX IF NOT EXISTS entries_feedID_date_index ON entries (feedID, date) ',

            // Speed up lookup when checking for updates.
            'CREATE INDEX IF NOT EXISTS entries_primaryHash_index ON entries (primaryHash) ',

            // Speed up SELECTs in the bookmarks observer.
            'CREATE INDEX IF NOT EXISTS entries_bookmarkID_index ON entries (bookmarkID) ',
            'CREATE INDEX IF NOT EXISTS entries_entryURL_index ON entries (entryURL)     ',

            'CREATE INDEX IF NOT EXISTS entry_tagName_index ON entry_tags (tagName)',

            'PRAGMA journal_mode=WAL',

            'ANALYZE'
        )

        Connection.schemaVersion = DATABASE_VERSION;
    },

    upgradeDatabase: function StorageInternal_upgradeDatabase() {
        switch (Connection.schemaVersion) {
            // To 1.5b2
            case 9:
                // Remove dead rows from entries_text.
                Connection.executeSQL('DELETE FROM entries_text                       '+
                                      'WHERE rowid IN (                               '+
                                      '     SELECT entries_text.rowid                 '+
                                      '     FROM entries_text LEFT JOIN entries       '+
                                      '          ON entries_text.rowid = entries.id   '+
                                      '     WHERE NOT EXISTS (                        '+
                                      '         SELECT id                             '+
                                      '         FROM entries                          '+
                                      '         WHERE entries_text.rowid = entries.id '+
                                      '     )                                         '+
                                     ')  AND rowid <> (SELECT max(rowid) from entries_text)  ');

            // To 1.5b3
            case 10:
                Connection.executeSQL('ALTER TABLE feeds ADD COLUMN lastFaviconRefresh INTEGER DEFAULT 0');

            // To 1.5
            case 11:
                Connection.executeSQL('ANALYZE');

            // These were for one-time fixes on 1.5 branch.
            case 12:
            case 13:

            // To 1.6.
            case 14:
                Connection.executeSQL('PRAGMA journal_mode=WAL');

            // To 1.7b1
            case 15:
                Connection.executeSQL('ALTER TABLE feeds ADD COLUMN omitInUnread INTEGER DEFAULT 0');

            // To 1.7. One-time fix for table corruption.
            case 16:
                Connection.executeSQL(
                    'DELETE FROM entries WHERE rowid NOT IN (SELECT docid FROM entries_text)',
                    'DELETE FROM entries_text WHERE docid NOT IN (SELECT rowid FROM entries)',
                    'INSERT OR IGNORE INTO entries_text(rowid) SELECT seq FROM sqlite_sequence WHERE name=\'entries\''
                );

        }

        Connection.schemaVersion = DATABASE_VERSION;
    },


    // See Storage.
    getFeed: function StorageInternal_getFeed(aFeedID) {
        for (let feed of this.getAllFeeds(true, true)) {
            if (feed.feedID == aFeedID)
                return feed;
        }

        return null;
    },

    /**
     * See Storage.
     *
     * It's not worth the trouble to make this function asynchronous like the
     * rest of the IO, as in-memory cache is practically always available.
     * However, in the rare case when the cache has just been invalidated
     * and hasn't been refreshed yet, we must fall back to a synchronous query.
     */
    getAllFeeds: function StorageInternal_getAllFeeds(aIncludeFolders, aIncludeInactive) {
        if (!this.allItemsCache)
            this.refreshFeedsCache(true);

        if (aIncludeFolders && aIncludeInactive)
            return this.allItemsCache;
        else if (aIncludeFolders)
            return this.activeItemsCache;
        else
            return this.activeFeedsCache;
    },

    refreshFeedsCache: function StorageInternal_refreshFeedsCache(aSynchronous, aCallback) {
        let resume = StorageInternal_refreshFeedsCache.resume;

        this.allItemsCache = null;
        this.activeItemsCache = null;
        this.activeFeedsCache = null;

        let results, error;
        if (aSynchronous) {
            if (this.pendingRefreshCacheStatement) {
                this.pendingRefreshCacheStatement.cancel();
                this.pendingRefreshCacheStatement = null;
            }

            results = Stm.getAllFeeds.results;
        }
        else {
            this.pendingRefreshCacheStatement = Stm.getAllFeeds.getResultsAsync(resume);
            [results, error] = yield undefined;
            this.pendingRefreshCacheStatement = null;
        }

        // Do not blow the cache in the case results could not be fetched.
        if (error || !results)
            return;

        this.allItemsCache = [];
        this.activeItemsCache = [];
        this.activeFeedsCache = [];

        for (let row of results) {
            let feed = new Feed();
            for (let column in row)
                feed[column] = row[column];

            this.allItemsCache.push(feed);
            if (!feed.hidden) {
                this.activeItemsCache.push(feed);
                if (!feed.isFolder)
                    this.activeFeedsCache.push(feed);
            }
        }

        Object.freeze(this.allItemsCache);
        Object.freeze(this.activeItemsCache);
        Object.freeze(this.activeFeedsCache);

        if (aCallback)
            aCallback();
    }.gen(),

    // See Storage.
    getAllTags: function StorageInternal_getAllTags(aCallback) {
        Stm.getAllTags.getResultsAsync(function(results) {
            aCallback([row.tagName for (row of results)]);
        })
    },


    // See Storage.
    processFeed: function StorageInternal_processFeed(aFeed, aEntries, aCallback) {
        new FeedProcessor(aFeed, aEntries, aCallback);
    },

    // See Storage.
    changeFeedProperties: function StorageInternal_changeFeedProperties(aPropertyBags, aCallback) {
        let resume = StorageInternal_changeFeedProperties.resume;

        let propertyBags = Array.isArray(aPropertyBags) ? aPropertyBags : [aPropertyBags];

        let tearDownCache = false;
        let invalidateFeedlist = false;

        for (let propertyBag of propertyBags) {
            let cachedFeed = Storage.getFeed(propertyBag.feedID);
            let params = {};

            for (let property in Stm.changeFeedProperties.params) {
                if (property in propertyBag) {
                    params[property] = propertyBag[property];

                    if (cachedFeed[property] != propertyBag[property]) {
                        // Update cache manually to avoid tearing it down.
                        cachedFeed[property] = propertyBag[property];

                        switch (property) {
                            // It would be more complex to manually update cache when
                            // the "hidden" property changes, because there are separate
                            // arrays for active and inactive feeds.
                            case 'hidden':
                                tearDownCache = true;
                                // Fall through...

                            case 'parent':
                            case 'rowIndex':
                            case 'title':
                            case 'omitInUnread':
                                invalidateFeedlist = true;
                                break;

                            case 'entryAgeLimit':
                                this.expireEntries(cachedFeed);
                                break;
                        }
                    }
                }
                else {
                    params[property] = cachedFeed[property];
                }
            }

            Stm.changeFeedProperties.paramSets.push(params);
        }

        yield Stm.changeFeedProperties.executeAsync(resume);

        if (tearDownCache)
            yield StorageInternal.refreshFeedsCache(false, resume);

        if (invalidateFeedlist)
            Services.obs.notifyObservers(null, 'brief:invalidate-feedlist', '');

        if (aCallback)
            aCallback();
    }.gen(),

    /**
     * Moves entries to Trash if they exceed the age limit or the number limit.
     *
     * @param aFeed [optional]
     *        The feed whose entries to expire. If not provided, all feeds are processed.
     */
    expireEntries: function StorageInternal_expireEntries(aFeed) {
        let resume = StorageInternal_expireEntries.resume;

        let feeds = aFeed ? [aFeed] : this.getAllFeeds();

        let feedsWithAgeLimit = feeds.filter(function(f) f.entryAgeLimit);
        let feedsWithoutAgeLimit = feeds.filter(function(f) !f.entryAgeLimit);

        // Delete entries exceeding the global number limit.
        if (Prefs.getBoolPref('database.limitStoredEntries')) {
            for (let feed of feeds) {
                let query = new Query({
                    feeds: [feed.feedID],
                    deleted: Storage.ENTRY_STATE_NORMAL,
                    starred: false,
                    sortOrder: Query.prototype.SORT_BY_DATE,
                    offset: Prefs.getIntPref('database.maxStoredEntries')
                })

                yield query.deleteEntries(Storage.ENTRY_STATE_TRASHED, resume);
            }
        }

        // Delete old entries in feeds that don't have per-feed setting enabled.
        if (Prefs.getBoolPref('database.expireEntries') && feedsWithoutAgeLimit.length) {
            let expirationAge = Prefs.getIntPref('database.entryExpirationAge');

            let query = new Query({
                feeds: feedsWithoutAgeLimit.map(function(f) f.feedID),
                deleted: Storage.ENTRY_STATE_NORMAL,
                starred: false,
                endDate: Date.now() - expirationAge * 86400000
            })

            yield query.deleteEntries(Storage.ENTRY_STATE_TRASHED, resume);
        }

        // Delete old entries based on per-feed limit.
        if (feedsWithAgeLimit.length) {
            for (let feed of feedsWithAgeLimit) {
                let query = new Query({
                    feeds: [feed.feedID],
                    deleted: Storage.ENTRY_STATE_NORMAL,
                    starred: false,
                    endDate: Date.now() - feed.entryAgeLimit * 86400000
                })

                query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
            }
        }
    }.gen(),

    // Permanently removes deleted items from database.
    purgeDeleted: function StorageInternal_purgeDeleted() {
        Stm.purgeDeletedEntriesText.params = {
            'deletedState': Storage.ENTRY_STATE_DELETED,
            'currentDate': Date.now(),
            'retentionTime': DELETED_FEEDS_RETENTION_TIME
        }

        Stm.purgeDeletedEntries.params = {
            'deletedState': Storage.ENTRY_STATE_DELETED,
            'currentDate': Date.now(),
            'retentionTime': DELETED_FEEDS_RETENTION_TIME
        }

        Stm.purgeDeletedFeeds.params = {
            'currentDate': Date.now(),
            'retentionTime': DELETED_FEEDS_RETENTION_TIME
        }

        Connection.executeAsync([Stm.purgeDeletedEntriesText,
                                 Stm.purgeDeletedEntries,
                                 Stm.purgeDeletedFeeds])

        // Prefs can only store longs while Date is a long long.
        let now = Math.round(Date.now() / 1000);
        Prefs.setIntPref('database.lastPurgeTime', now);
    },

    // nsIObserver
    observe: function StorageInternal_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'quit-application':
                Bookmarks.removeObserver(BookmarkObserver);
                Prefs.removeObserver('', this);

                Services.obs.removeObserver(this, 'quit-application');
                Services.obs.removeObserver(this, 'idle-daily');

                BookmarkObserver.syncDelayTimer = null;
                break;

            case 'idle-daily':
                // Integer prefs are longs while Date is a long long.
                let now = Math.round(Date.now() / 1000);
                let lastPurgeTime = Prefs.getIntPref('database.lastPurgeTime');
                if (now - lastPurgeTime > PURGE_ENTRIES_INTERVAL)
                    this.purgeDeleted();
                break;

            case 'nsPref:changed':
                switch (aData) {
                    case 'homeFolder':
                        this.homeFolderID = Prefs.getIntPref('homeFolder');
                        this.syncWithLivemarks();
                        break;

                    case 'database.expireEntries':
                    case 'database.limitStoredEntries':
                        if (Prefs.getBoolPref(aData))
                            this.expireEntries();
                        break;

                    case 'database.entryExpirationAge':
                    case 'database.maxStoredEntries':
                        this.expireEntries();
                        break;
                }
                break;
        }
    },


    // See Storage.
    syncWithLivemarks: function StorageInternal_syncWithLivemarks() {
        new LivemarksSync();
    },

    observers: [],

    // See Storage.
    addObserver: function StorageInternal_addObserver(aObserver) {
        this.observers.push(aObserver);
    },

    // See Storage.
    removeObserver: function StorageInternal_removeObserver(aObserver) {
        let index = this.observers.indexOf(aObserver);
        if (index !== -1)
            this.observers.splice(index, 1);
    },

    /**
     * Sets starred status of an entry.
     *
     * @param aState
     *        New state. TRUE for starred, FALSE for not starred.
     * @param aEntryID
     *        Subject entry.
     * @param aBookmarkID
     *        ItemId of the corresponding bookmark in Places database.
     * @param aDontNotify
     *        Don't notify observers.
     */
    starEntry: function StorageInternal_starEntry(aState, aEntryID, aBookmarkID, aDontNotify) {
        let resume = StorageInternal_starEntry.resume;

        if (aState) {
            Stm.starEntry.params = { 'bookmarkID': aBookmarkID, 'entryID': aEntryID };
            yield Stm.starEntry.executeAsync(resume);
        }
        else {
            Stm.unstarEntry.params = { 'id': aEntryID };
            yield Stm.unstarEntry.executeAsync(resume);
        }

        if (!aDontNotify) {
            let list = yield new Query(aEntryID).getEntryList(resume);
            for (let observer of StorageInternal.observers) {
                if (observer.onEntriesStarred)
                    observer.onEntriesStarred(list, aState);
            }
        }
    }.gen(),

    /**
     * Adds or removes a tag for an entry.
     *
     * @param aState
     *        TRUE to add the tag, FALSE to remove it.
     * @param aEntryID
     *        Subject entry.
     * @param aTagName
     *        Name of the tag.
     */
    tagEntry: function StorageInternal_tagEntry(aState, aEntryID, aTagName) {
        let resume = StorageInternal_tagEntry.resume;

        let params = { 'entryID': aEntryID, 'tagName': aTagName };

        if (aState) {
            Stm.checkTag.params = params;
            let results = yield Stm.checkTag.getResultsAsync(resume);
            if (results[0].alreadyTagged)
                return;

            Stm.tagEntry.params = params;
            yield Stm.tagEntry.executeAsync(resume);
        }
        else {
            Stm.untagEntry.params = params;
            yield Stm.untagEntry.executeAsync(resume);
        }

        // Update the serialized list of tags stored in entries_text table.
        let newTags = yield Utils.getTagsForEntry(aEntryID, resume);
        Stm.setSerializedTagList.params = {
            'tags': newTags.join(', '),
            'entryID': aEntryID
        }
        yield Stm.setSerializedTagList.executeAsync(resume);

        let list = yield new Query(aEntryID).getEntryList(resume);
        for (let observer of StorageInternal.observers) {
            if (observer.onEntriesTagged)
                observer.onEntriesTagged(list, aState, aTagName);
        }
    }.gen(),

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver])

}


/**
 * Evaluates provided entries, inserting any new items and updating existing
 * items when newer versions are found. Also updates feed's properties.
 */
function FeedProcessor(aFeed, aEntries, aCallback) {
    this.feed = aFeed;
    this.callback = aCallback;

    let newDateModified = new Date(aFeed.wrappedFeed.updated).getTime();
    let prevDateModified = aFeed.dateModified;

    if (aEntries.length && (!newDateModified || newDateModified > prevDateModified)) {
        this.remainingEntriesCount = aEntries.length;
        this.newOldestEntryDate = Date.now();

        this.updatedEntries = [];

        this.updateEntry = Stm.updateEntry.clone();
        this.insertEntry = Stm.insertEntry.clone();
        this.updateEntryText = Stm.updateEntryText.clone();
        this.insertEntryText = Stm.insertEntryText.clone();

        aEntries.forEach(this.processEntry, this);
    }
    else {
        aCallback(0);
    }

    Storage.changeFeedProperties({
        feedID: aFeed.feedID,
        oldestEntryDate: this.newOldestEntryDate || aFeed.oldestEntryDate,
        lastUpdated: Date.now(),
        dateModified: newDateModified
    });
}

FeedProcessor.prototype = {

    processEntry: function FeedProcessor_processEntry(aEntry) {
        if (aEntry.date && aEntry.date < this.newOldestEntryDate)
            this.newOldestEntryDate = aEntry.date;

        // This function checks whether a downloaded entry is already in the database or
        // it is a new one. To do this we need a way to uniquely identify entries. Many
        // feeds don't provide unique identifiers for their entries, so we have to use
        // hashes for this purpose. There are two hashes.
        // The primary hash is used as a standard unique ID throughout the codebase.
        // Ideally, we just compute it from the GUID provided by the feed. Otherwise, we
        // use the entry's URL.
        // There is a problem, though. Even when a feed does provide its own GUID, it
        // seems to randomly get lost (maybe a bug in the parser?). This means that the
        // same entry may sometimes be hashed using the GUID and other times using the
        // URL. Different hashes lead to the entry being duplicated.
        // This is why we need a secondary hash, which is always based on the URL. If the
        // GUID is empty (either because it was lost or because it wasn't provided to
        // begin with), we look up the entry using the secondary hash.
        let providedID = aEntry.wrappedEntry.id;
        let primarySet = providedID ? [this.feed.feedID, providedID]
                                    : [this.feed.feedID, aEntry.entryURL];
        let secondarySet = [this.feed.feedID, aEntry.entryURL];

        // Special case for MediaWiki feeds: include the date in the hash. In
        // "Recent changes" feeds, entries for subsequent edits of a page differ
        // only in date (not in URL or GUID).
        let generator = this.feed.wrappedFeed.generator;
        if (generator && generator.agent.match('MediaWiki')) {
            primarySet.push(aEntry.date);
            secondarySet.push(aEntry.date);
        }

        let primaryHash = Utils.hashString(primarySet.join(''));
        let secondaryHash = Utils.hashString(secondarySet.join(''));

        // Look up if the entry is already present in the database.
        if (providedID) {
            var select = Stm.getEntryByPrimaryHash;
            select.params.primaryHash = primaryHash;
        }
        else {
            select = Stm.getEntryBySecondaryHash;
            select.params.secondaryHash = secondaryHash;
        }

        let storedID, storedPubDate, storedDateUpdated, isEntryRead;
        let self = this;

        select.executeAsync({
            handleResult: function(row) {
                storedID = row.id;
                storedPubDate = row.date;
                storedDateUpdated = row.updated;
                isEntryRead = row.read;
            },

            handleCompletion: function(aReason) {
                if (aReason == REASON_FINISHED) {
                    if (storedID) {
                        // XXX Comparing storedPubDate is temporary. Done to avoid suddenly
                        // marking many entries as update for old user (before rev 1.72).
                        if (aEntry.updated && aEntry.updated > storedDateUpdated
                                           && aEntry.updated > storedPubDate) {
                            self.addUpdateParams(aEntry, storedID, isEntryRead);
                        }
                    }
                    else {
                        self.addInsertParams(aEntry, primaryHash, secondaryHash);
                    }
                }

                if (!--self.remainingEntriesCount)
                    self.executeAndNotify();
            }
        })
    },

    addUpdateParams: function FeedProcessor_addUpdateParams(aEntry, aStoredEntryID, aIsRead) {
        let title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags
        let markUnread = Storage.getFeed(this.feed.feedID).markModifiedEntriesUnread;

        this.updateEntry.paramSets.push({
            'updated': aEntry.updated,
            'read': markUnread && aIsRead == 1 ? 2 : aIsRead,
            'id': aStoredEntryID
        })

        this.updateEntryText.paramSets.push({
            'title': title,
            'content': aEntry.content || aEntry.summary,
            'authors': aEntry.authors,
            'id': aStoredEntryID
        })

        this.updatedEntries.push(aStoredEntryID);
    },

    addInsertParams: function FeedProcessor_addInsertParams(aEntry, aPrimaryHash, aSecondaryHash) {
        let title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags

        try {
            var insertEntryParamSet = {
                'feedID': this.feed.feedID,
                'primaryHash': aPrimaryHash,
                'secondaryHash': aSecondaryHash,
                'providedID': aEntry.wrappedEntry.id,
                'entryURL': aEntry.entryURL,
                'date': aEntry.date || Date.now(),
                'updated': aEntry.updated || 0
            }

            var insertEntryTextParamSet = {
                'title': title,
                'content': aEntry.content || aEntry.summary,
                'authors': aEntry.authors
            }
        }
        catch (ex) {
            Cu.reportError('Error updating feeds. Failed to bind parameters to insert statement.');
            Cu.reportError(ex);
            return;
        }

        this.insertEntry.paramSets.push(insertEntryParamSet);
        this.insertEntryText.paramSets.push(insertEntryTextParamSet);
    },

    executeAndNotify: function FeedProcessor_executeAndNotify() {
        let resume = FeedProcessor_executeAndNotify.resume;

        let insertedEntries = [];

        if (this.insertEntry.paramSets.length) {
            if (this.insertEntry.paramSets.length != this.insertEntryText.paramSets.length) {
                this.callback(0);
                throw new Error('Mismatched parameteres between insertEntry and insertEntryText statements.');
            }

            Stm.getLastRowids.params.count = this.insertEntry.paramSets.length;
            let statements = [this.insertEntry, this.insertEntryText, Stm.getLastRowids];

            let reason = yield Connection.executeAsync(statements, {
                handleResult: function(row) {
                    insertedEntries.push(row.id);
                },
                handleCompletion: resume
            })

            if (reason === REASON_FINISHED) {
                let list = yield new Query(insertedEntries).getEntryList(resume);
                for (let observer of StorageInternal.observers) {
                    if (observer.onEntriesAdded)
                        observer.onEntriesAdded(list);
                }

                StorageInternal.expireEntries(this.feed);
            }
        }

        if (this.updateEntry.paramSets.length) {
            let statements = [this.updateEntry, this.updateEntryText];

            yield Connection.executeAsync(statements, resume);

            let list = yield new Query(this.updatedEntries).getEntryList(resume);
            for (let observer of StorageInternal.observers) {
                if (observer.onEntriesUpdated)
                    observer.onEntriesUpdated(list);
            }
        }

        this.callback(insertedEntries.length);
    }.gen()

}


/**
 * A query to the Brief's database. Constraints are AND-ed.
 *
 * @param aConstraints
 *        Entry ID, array of entry IDs, or object containing name-value pairs
 *        of query constraints.
 */
function Query(aConstraints) {
    if (!aConstraints)
        return;

    if (typeof aConstraints == 'number') {
        this.entries = [aConstraints];
    }
    else if (Array.isArray(aConstraints)) {
        this.entries = aConstraints;
    }
    else {
        for (let constraint in aConstraints)
            this[constraint] = aConstraints[constraint];
    }
}

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
     * By which column to sort the results.
     */
    SORT_BY_DATE: 1,
    SORT_BY_TITLE: 2,
    SORT_BY_FEED_ROW_INDEX: 3,

    sortOrder: undefined,

    /**
     * Direction in which to sort the results.
     */
    SORT_DESCENDING: 0,
    SORT_ASCENDING: 1,

    sortDirection: 0,

    /**
     * Include hidden feeds i.e. the ones whose Live Bookmarks are no longer
     * to be found in Brief's home folder. This attribute is ignored if
     * the list of feeds is explicitly specified by Query.feeds.
     */
    includeHiddenFeeds: false,

     /**
     * Include feeds the user has explicitly marked to be omitted from global unread views.
     */
    includeOmittedUnread: true,

    /**
     * Indicates if there are any entries that match this query.
     *
     * @param aCallback
     */
    hasMatches: function Query_hasMatches(aCallback) {
        let sql = 'SELECT EXISTS (SELECT entries.id ' + this._getQueryString(true) + ') AS found';

        new Statement(sql).executeAsync({
            handleResult: function(row) aCallback(row.found),
            handleError: this._onDatabaseError
        })
    },

    /**
     * Get a simple list of entries.
     * XXX Check performance.
     *
     * @param aCallback
     *        Receives an array if IDs.
     */
    getEntries: function Query_getEntries(aCallback) {
        let sql = 'SELECT entries.id ' + this._getQueryString(true);
        new Statement(sql).getResultsAsync(function(results) {
			aCallback([row.id for (row of results)])
		}, this._onDatabaseError);
    },


    /**
     * Get entries with all their properties.
     *
     * @param aCallback
     *        Receives an array of Entry objects.
     */
    getFullEntries: function Query_getFullEntries(aCallback) {
        let sql = 'SELECT entries.id, entries.feedID, entries.entryURL, entries.date,   '+
                  '       entries.read, entries.starred, entries.updated,               '+
                  '       entries.bookmarkID, entries_text.title, entries_text.content, '+
                  '       entries_text.authors, entries_text.tags                       ';
        sql += this._getQueryString(true, true);

        new Statement(sql).getResultsAsync(function(results) {
            let entries = results.map(function(row) {
                let entry = new Entry();

                for (let column in row)
                    entry[column] = row[column]

                entry.markedUnreadOnUpdate = row['read'] == 2;
                entry.read = row['read'] == 1;

                return entry;
            })

            aCallback(entries);
        }, this._onDatabaseError)
    },


    /**
     * Get values of a single property of each of the entries.
     *
     * @param aPropertyName
     *        Name of the property.
     * @param aDistinct
     *        Don't include multiple entries with the same value.
     * @param aCallback
     *        Receives an array of values of the requested property.
     */
    getProperty: function Query_getProperty(aPropertyName, aDistinct, aCallback) {
        switch (aPropertyName) {
            case 'content':
            case 'title':
            case 'authors':
            case 'tags':
                var table = 'entries_text.';
                var getEntriesText = true;
                break;
            default:
                table = 'entries.';
        }

        let sql = 'SELECT entries.id, ' + table + aPropertyName +
                   this._getQueryString(true, getEntriesText);

        let values = [];

        new Statement(sql).executeAsync({
            handleResult: function(row) {
                let value = row[aPropertyName];
                if (!aDistinct || values.indexOf(value) == -1)
                    values.push(value);
            },

            handleCompletion: function(aReason) {
                aCallback(values);
            },

            handleError: this._onDatabaseError
        })
    },


    /**
     * Get the number of selected entries.
     *
     * @param aCallback
     */
    getEntryCount: function Query_getEntryCount(aCallback) {
        // Optimization: don't sort.
        let tempOrder = this.sortOrder;
        this.sortOrder = undefined;

        let sql = 'SELECT COUNT(1) AS count ' + this._getQueryString(true);

        new Statement(sql).executeAsync({
            handleResult: function(row) aCallback(row.count),
            handleError: this._onDatabaseError
        })

        this.sortOrder = tempOrder;
    },


    /**
     * Get an EntryList of entries.
     */
    getEntryList: function Query_getEntryList(aCallback) {
        let entryIDs = [];
        let feedIDs = [];
        let tags = [];

        let tempHidden = this.includeHiddenFeeds;
        this.includeHiddenFeeds = false;
        let sql = 'SELECT entries.id, entries.feedID, entries_text.tags '
                   + this._getQueryString(true, true);
        this.includeHiddenFeeds = tempHidden;

        new Statement(sql).executeAsync({
            handleResult: function(row) {
                entryIDs.push(row.id);

                if (feedIDs.indexOf(row.feedID) == -1)
                    feedIDs.push(row.feedID);

                if (row.tags) {
                    let arr = row.tags.split(', ');
                    let newTags = arr.filter(function(t) tags.indexOf(t) === -1);
                    tags = tags.concat(newTags);
                }
            },

            handleCompletion: function(aReason) {
                let list = new EntryList();
                list.IDs = entryIDs;
                list.feedIDs = feedIDs;
                list.tags = tags;

                aCallback(list);
            }
        })
    },


    /**
     * Mark entries as read/unread.
     *
     * @param aState
     *        New state of entries (TRUE for read, FALSE for unread).
     */
    markEntriesRead: function Query_markEntriesRead(aState) {
        let resume = Query_markEntriesRead.resume;

        // Try not to include entries which already have the desired state,
        // but we can't omit them if a specific range of the selected entries
        // is meant to be marked.
        let tempRead = this.read;
        if (!this.limit && !this.offset)
            this.read = !aState;

        let list = yield this.getEntryList(resume);

        if (list.length) {
            let sql = 'UPDATE entries SET read = :read ';
            let update = new Statement(sql + this._getQueryString());

            update.params.read = aState ? 1 : 0;
            yield update.executeAsync(resume);

            this.read = tempRead;

            for (let observer of StorageInternal.observers) {
                if (observer.onEntriesMarkedRead)
                    observer.onEntriesMarkedRead(list, aState);
            }
        }
        else {
            this.read = tempRead;
        }
    }.gen(),

    /**
     * Set the deleted state of the selected entries or remove them from the database.
     *
     * @param aState
     *        The new deleted state (as defined by constants in Storage).
     * @param aCallback
     */
    deleteEntries: function Query_deleteEntries(aState, aCallback) {
        let resume = Query_deleteEntries.resume;

        let list = yield this.getEntryList(resume);
        if (list.length) {
            let sql = 'UPDATE entries SET deleted = ' + aState + this._getQueryString();
            yield new Statement(sql).executeAsync(resume);

            for (let observer of StorageInternal.observers) {
                if (observer.onEntriesDeleted)
                    observer.onEntriesDeleted(list, aState);
            }
        }

        if (aCallback)
            aCallback();
    }.gen(),


    /**
     * Bookmark/unbookmark URLs of the selected entries.
     *
     * @param aState
     *        New state of entries. TRUE to bookmark, FALSE to unbookmark.
     *
     * This function bookmarks URIs of the selected entries. It doesn't star the entries
     * in the database or send notifications - that part is performed by the bookmark
     * observer.
     */
    bookmarkEntries: function Query_bookmarkEntries(aState) {
        let resume = Query_bookmarkEntries.resume;
        let transactions = [];

        for (let entry of yield this.getFullEntries(resume)) {
            let uri = Utils.newURI(entry.entryURL);
            if (!uri)
                continue;

            if (aState) {
                let container = Places.unfiledBookmarksFolderId;
                let trans = new PlacesCreateBookmarkTransaction(uri, container,
                                                                -1, entry.title);
                transactions.push(trans);
            }
            else {
                let bookmarks = [b for (b of Bookmarks.getBookmarkIdsForURI(uri, {}))
                                 if (yield Utils.isNormalBookmark(b, resume))];
                if (bookmarks.length) {
                    for (let i = bookmarks.length - 1; i >= 0; i--)
                        transactions.push(new PlacesRemoveItemTransaction(bookmarks[i]));
                }
                else {
                    // If there are no bookmarks for an URL that is starred in our
                    // database, it means that the database is out of sync and we
                    // must update the database directly.
                    StorageInternal.starEntry(false, entry.id, bookmarks[0]);
                }
            }
        }

        let aggregatedTrans = new PlacesAggregatedTransaction('', transactions);
        Places.transactionManager.doTransaction(aggregatedTrans);
    }.gen(),

    /**
     * Verifies entries' starred statuses and their tags.
     *
     * This function syncs the entry status with user's bookmarks, in case it went
     * out of sync, for example if Brief was disabled or uninstalled.
     */
    verifyBookmarksAndTags: function Query_verifyBookmarksAndTags() {
        let resume = Query_verifyBookmarksAndTags.resume;

        for (let entry of yield this.getFullEntries(resume)) {
            let uri = Utils.newURI(entry.entryURL);
            if (!uri)
                return;

            let allBookmarks = Bookmarks.getBookmarkIdsForURI(uri, {});

            // Verify bookmarks.
            let normalBookmarks = [b for (b of allBookmarks) if (yield Utils.isNormalBookmark(b, resume))];
            if (entry.starred && !normalBookmarks.length)
                StorageInternal.starEntry(false, entry.id);
            else if (!entry.starred && normalBookmarks.length)
                StorageInternal.starEntry(true, entry.id, normalBookmarks[0]);

            // Verify tags.
            let storedTags = yield Utils.getTagsForEntry(entry.id, resume);
            let currentTags = allBookmarks.map(function(id) Bookmarks.getFolderIdForItem(id))
                                          .filter(Utils.isTagFolder)
                                          .map(function(id) Bookmarks.getItemTitle(id));

            for (let tag of storedTags) {
                if (currentTags.indexOf(tag) === -1)
                    StorageInternal.tagEntry(false, entry.id, tag);
            }

            for (let tag of currentTags) {
                if (storedTags.indexOf(tag) === -1)
                    StorageInternal.tagEntry(true, entry.id, tag);
            }
        }
    }.gen(),


    /**
     * Actual list of folders selected by the query, including subfolders
     * of folders specified by Query.folders.
     */
    _effectiveFolders: null,


    _onDatabaseError: function BriefQuery__onDatabaseError(aError) {
        // Ignore "SQL logic error or missing database" error which full-text search
        // throws when the query doesn't contain at least one non-excluded term.
        if (aError.result != 1)
            throw new StorageError('Error when executing Query', aError.message);
    },

    /**
     * Constructs SQL query constraints query's properties.
     *
     * @param aForSelect      Build a string optimized for a SELECT statement.
     * @param aGetFullEntries Forces including entries_text table (otherwise, it is
     *                        included only when it is used by the query constraints).
     * @returns String containing the part of an SQL statement after WHERE clause.
     */
    _getQueryString: function Query__getQueryString(aForSelect, aGetFullEntries) {
        let text = aForSelect ? ' FROM entries '
                              : ' WHERE entries.id IN (SELECT entries.id FROM entries ';

        if (!this.feeds && !this.includeHiddenFeeds)
            text += ' INNER JOIN feeds ON entries.feedID = feeds.feedID ';

        if (aGetFullEntries || this.searchString || this.sortOrder == this.SORT_BY_TITLE)
            text += ' INNER JOIN entries_text ON entries.id = entries_text.rowid ';

        if (this.tags)
            text += ' INNER JOIN entry_tags ON entries.id = entry_tags.entryID ';

        let constraints = [];

        if (!this.includeOmittedUnread)
            constraints.push('(feeds.omitInUnread = 0)');

        if (this.folders) {
            if (!this.folders.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            /**
             * Compute the actual list of folders to be selected, including subfolders
             * of folders specified by Query.folders.
             */
            this._effectiveFolders = this.folders;
            this._traverseFolderChildren(StorageInternal.homeFolderID);

            let con = '(feeds.parent = "';
            con += this._effectiveFolders.join('" OR feeds.parent = "');
            con += '")';
            constraints.push(con);
        }

        if (this.feeds) {
            if (!this.feeds.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            let con = '(entries.feedID = "';
            con += this.feeds.join('" OR entries.feedID = "');
            con += '")';
            constraints.push(con);
        }

        if (this.entries) {
            if (!this.entries.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            let con = '(entries.id = ';
            con += this.entries.join(' OR entries.id = ');
            con += ')';
            constraints.push(con);
        }

        if (this.tags) {
            if (!this.tags.length)
                throw Components.results.NS_ERROR_INVALID_ARG;

            let con = '(entry_tags.tagName = "';
            con += this.tags.join('" OR entry_tags.tagName = "');
            con += '")';
            constraints.push(con);
        }

        if (this.searchString) {
            let con = 'entries_text MATCH \'' + this.searchString.replace("'",' ') + '\'';
            constraints.push(con);
        }

        if (this.read === true)
            constraints.push('entries.read = 1');
        else if (this.read === false)
            constraints.push('(entries.read = 0 OR entries.read = 2)');

        if (this.starred === true)
            constraints.push('entries.starred = 1');
        else if (this.starred === false)
            constraints.push('entries.starred = 0');

        if (this.deleted !== undefined)
            constraints.push('entries.deleted = ' + this.deleted);

        if (this.startDate !== undefined)
            constraints.push('entries.date >= ' + this.startDate);
        if (this.endDate !== undefined)
            constraints.push('entries.date <= ' + this.endDate);

        if (!this.includeHiddenFeeds && !this.feeds)
            constraints.push('feeds.hidden = 0');

        if (constraints.length)
            text += ' WHERE ' + constraints.join(' AND ') + ' ';

        if (this.sortOrder !== undefined) {
            switch (this.sortOrder) {
                case this.SORT_BY_FEED_ROW_INDEX:
                    var sortOrder = 'feeds.rowIndex ';
                    break;
                case this.SORT_BY_DATE:
                    sortOrder = 'entries.date ';
                    break;
                case this.SORT_BY_TITLE:
                    sortOrder = 'entries_text.title ';
                    break;
                default:
                    throw Components.results.NS_ERROR_ILLEGAL_VALUE;
            }

            let sortDir = (this.sortDirection == this.SORT_ASCENDING) ? 'ASC' : 'DESC';
            text += 'ORDER BY ' + sortOrder + sortDir;

            // Sort by rowid, so that entries that are equal in respect of primary
            // sorting criteria are always returned in the same (as opposed to
            // undefined) order.
            text += ', entries.rowid ' + sortDir;
        }

        if (this.limit !== undefined)
            text += ' LIMIT ' + this.limit;
        if (this.offset > 0) {
            if (this.limit === undefined)
                text += ' LIMIT -1 '
            text += ' OFFSET ' + this.offset;
        }

        if (!aForSelect)
            text += ') ';

        return text;
    },

    _traverseFolderChildren: function Query__traverseFolderChildren(aFolder) {
        let isEffectiveFolder = (this._effectiveFolders.indexOf(aFolder) != -1);

        for (let item of Storage.getAllFeeds(true)) {
            if (item.parent == aFolder && item.isFolder) {
                if (isEffectiveFolder)
                    this._effectiveFolders.push(item.feedID);
                this._traverseFolderChildren(item.feedID);
            }
        }
    }

}


let BookmarkObserver = {

    livemarksSyncPending: false,
    batching: false,
    homeFolderContentModified: false,

    // nsINavBookmarkObserver
    onEndUpdateBatch: function BookmarkObserver_onEndUpdateBatch() {
        this.batching = false;
        if (this.homeFolderContentModified)
            this.delayedLivemarksSync();
        this.homeFolderContentModified = false;
    },

    // nsINavBookmarkObserver
    onBeginUpdateBatch: function BookmarkObserver_onBeginUpdateBatch() {
        this.batching = true;
    },

    // nsINavBookmarkObserver
    onItemAdded: function BookmarkObserver_onItemAdded(aItemID, aParentID, aIndex, aItemType,
                                                       aURI, aTitle, aDateAdded) {
        let resume = BookmarkObserver_onItemAdded.resume;

        if (aItemType == Bookmarks.TYPE_FOLDER && Utils.isInHomeFolder(aParentID)) {
            this.delayedLivemarksSync();
            return;
        }

        // Only care about plain bookmarks and tags.
        if (aItemType != Bookmarks.TYPE_BOOKMARK || (yield Utils.isLivemark(aParentID, resume)))
            return;

        // Find entries with the same URI as the added item and tag or star them.
        for (let entry of yield Utils.getEntriesByURL(aURI.spec, resume)) {
            if (Utils.isTagFolder(aParentID)) {
                let tagName = Bookmarks.getItemTitle(aParentID);
                StorageInternal.tagEntry(true, entry, tagName);
            }
            else {
                StorageInternal.starEntry(true, entry, aItemID);
            }
        }
    }.gen(),


    // nsINavBookmarkObserver
    onItemRemoved: function BookmarkObserver_onItemRemoved(aItemID, aParentID, aIndex, aItemType, aURI) {
        let resume = BookmarkObserver_onItemRemoved.resume;

        if (Utils.isLivemarkStored(aItemID) || aItemID == StorageInternal.homeFolderID) {
            this.delayedLivemarksSync();
            return;
        }

        // Obtain parent title and type before any async calls, as the parent may be
        // removed before the function resumes.
        let parentTitle = Bookmarks.getItemTitle(aParentID);
        let isTag = Utils.isTagFolder(aParentID);

        // Only care about plain bookmarks and tags.
        if (aItemType != Bookmarks.TYPE_BOOKMARK || (yield Utils.isLivemark(aParentID, resume)))
            return;


        if (isTag) {
            for (let entry of yield Utils.getEntriesByURL(aURI.spec, resume))
                StorageInternal.tagEntry(false, entry, parentTitle);
        }
        else {
            let entries = yield Utils.getEntriesByBookmarkID(aItemID, resume);

            // Look for other bookmarks for this URI. If there is another
            // bookmark for this URI, don't unstar the entry, but update
            // its bookmarkID to point to that bookmark.
            if (entries.length) {
                let uri = Utils.newURI(aURI.spec);
                var bookmarks = [b for (b of Bookmarks.getBookmarkIdsForURI(uri, {}))
                                 if (yield Utils.isNormalBookmark(b, resume))];
            }

            for (let entry of entries) {
                if (bookmarks.length)
                    StorageInternal.starEntry(true, entry.id, bookmarks[0], true);
                else
                    StorageInternal.starEntry(false, entry.id);
            }
        }
    }.gen(),

    // nsINavBookmarkObserver
    onItemMoved: function BookmarkObserver_onItemMoved(aItemID, aOldParent, aOldIndex,
                                                       aNewParent, aNewIndex, aItemType) {
        let wasInHome = Utils.isLivemarkStored(aItemID);
        let isInHome = aItemType == Bookmarks.TYPE_FOLDER && Utils.isInHomeFolder(aNewParent);
        if (wasInHome || isInHome)
            this.delayedLivemarksSync();
    },

    // nsINavBookmarkObserver
    onItemChanged: function BookmarkObserver_onItemChanged(aItemID, aProperty,
                                                           aIsAnnotationProperty, aNewValue,
                                                           aLastModified, aItemType, aParentID) {
        let resume = BookmarkObserver_onItemChanged.resume;

        switch (aProperty) {
            case 'title':
                let feed = Utils.getFeedByBookmarkID(aItemID);
                if (feed) {
                    Stm.setFeedTitle.params = { 'title': aNewValue, 'feedID': feed.feedID };
                    yield Stm.setFeedTitle.executeAsync(resume);
                    feed.title = aNewValue; // Update cache.
                    Services.obs.notifyObservers(null, 'brief:feed-title-changed', feed.feedID);
                }
                else if (Utils.isTagFolder(aItemID)) {
                    this.renameTag(aItemID, aNewValue);
                }
                break;

            case 'uri':
                // Unstar any entries with the old URI.
                for (let entry of yield Utils.getEntriesByBookmarkID(aItemID, resume))
                    StorageInternal.starEntry(false, entry.id);

                // Star any entries with the new URI.
                for (let entry of yield Utils.getEntriesByURL(aNewValue, resume))
                    StorageInternal.starEntry(true, entry, aItemID);

                break;
        }
    },

    // nsINavBookmarkObserver
    onItemVisited: function BookmarkObserver_aOnItemVisited(aItemID, aVisitID, aTime) { },

    get syncDelayTimer() {
        if (!this.__syncDelayTimer)
            this.__syncDelayTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        return this.__syncDelayTimer;
    },

    delayedLivemarksSync: function BookmarkObserver_delayedLivemarksSync() {
        if (this.batching) {
            this.homeFolderContentModified = true;
        }
        else {
            if (this.livemarksSyncPending)
                this.syncDelayTimer.cancel();

            this.syncDelayTimer.init(this, LIVEMARKS_SYNC_DELAY, Ci.nsITimer.TYPE_ONE_SHOT);
            this.livemarksSyncPending = true;
        }
    },

    /**
     * Syncs tags when a tag folder is renamed by removing tags with the old name
     * and re-tagging the entries using the new one.
     *
     * @param aTagFolderID
     *        itemId of the tag folder that was renamed.
     * @param aNewName
     *        New name of the tag folder, i.e. new name of the tag.
     */
    renameTag: function BookmarkObserver_renameTag(aTagFolderID, aNewName) {
        let resume = BookmarkObserver_renameTag.resume;

        // Get bookmarks in the renamed tag folder.
        let options = Places.history.getNewQueryOptions();
        let query = Places.history.getNewQuery();
        query.setFolders([aTagFolderID], 1);
        let result = Places.history.executeQuery(query, options);
        result.root.containerOpen = true;

        for (let i = 0; i < result.root.childCount; i++) {
            let tagID = result.root.getChild(i).itemId;
            let uri = Bookmarks.getBookmarkURI(tagID);

            for (let entryID of yield Utils.getEntriesByURL(uri.spec, resume)) {
                StorageInternal.tagEntry(true, entryID, aNewName);

                let currentTags = Bookmarks.getBookmarkIdsForURI(uri, {})
                                           .map(function(id) Bookmarks.getFolderIdForItem(id))
                                           .filter(Utils.isTagFolder)
                                           .map(function(id) Bookmarks.getItemTitle(id));

                let storedTags = yield Utils.getTagsForEntry(entryID, resume);

                let removedTags = storedTags.filter(function(t) currentTags.indexOf(t) === -1);

                for (let tag of removedTags)
                    StorageInternal.tagEntry(false, entryID, tag);
            }
        }

        result.root.containerOpen = false;
    }.gen(),

    observe: function BookmarkObserver_observe(aSubject, aTopic, aData) {
        if (aTopic == 'timer-callback') {
            this.livemarksSyncPending = false;
            Storage.syncWithLivemarks();
        }
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsINavBookmarkObserver, Ci.nsIObserver])

}


/**
 * Synchronizes the list of feeds stored in the database with
 * the livemarks available in the Brief's home folder.
 */
let LivemarksSync = function LivemarksSync() {
    let resume = LivemarksSync.resume;

    if (!this.checkHomeFolder())
        return;

    let livemarks = [];

    // Get a list of folders and Live Bookmarks in the user's home folder.
    let options = Places.history.getNewQueryOptions();
    let query = Places.history.getNewQuery();
    query.setFolders([StorageInternal.homeFolderID], 1);
    options.excludeItems = true;
    let result = Places.history.executeQuery(query, options);
    yield this.traversePlacesQueryResults(result.root, livemarks, resume);

    let storedFeeds = Storage.getAllFeeds(true, true);
    let oldFeeds = [];
    let newFeeds = [];
    let changedFeeds = [];

    // Iterate through the found livemarks and compare them
    // with the feeds in the database.
    for (let livemark of livemarks) {
        // Find the matching feed in the database.
        let feed = null;
        for (let storedFeed of storedFeeds) {
            if (storedFeed.feedID == livemark.feedID) {
                feed = storedFeed;
                break;
            }
        }

        // Feed already in the database.
        if (feed) {
            oldFeeds.push(feed);

            // Check if feed's properties are up to date.
            let properties = ['rowIndex', 'parent', 'title', 'bookmarkID'];
            if (feed.hidden || properties.some(function(p) feed[p] != livemark[p])) {
                changedFeeds.push({
                    'feedID'    : feed.feedID,
                    'hidden'    : 0,
                    'rowIndex'  : livemark.rowIndex,
                    'parent'    : livemark.parent,
                    'title'     : livemark.title,
                    'bookmarkID': livemark.bookmarkID
                });
            }
        }
        // Feed not found in the database. Insert new feed.
        else {
            Stm.insertFeed.paramSets.push({
                'feedID'    : livemark.feedID,
                'feedURL'   : livemark.feedURL || null,
                'title'     : livemark.title,
                'rowIndex'  : livemark.rowIndex,
                'isFolder'  : livemark.isFolder ? 1 : 0,
                'parent'    : livemark.parent,
                'bookmarkID': livemark.bookmarkID
            })

            newFeeds.push(livemark);
        }
    }

    // Hide any feeds that are no longer found among the livemarks.
    let missingFeeds = storedFeeds.filter(function(f) oldFeeds.indexOf(f) == -1 && !f.hidden);
    for (let feed of missingFeeds) {
        changedFeeds.push({
            'feedID': feed.feedID,
            'hidden': Date.now()
        });
    }

    if (Stm.insertFeed.paramSets.length) {
        yield Stm.insertFeed.executeAsync(resume);

        yield StorageInternal.refreshFeedsCache(false, resume);
        Services.obs.notifyObservers(null, 'brief:invalidate-feedlist', '');
    }

    if (changedFeeds.length) {
        yield Storage.changeFeedProperties(changedFeeds, false, resume);
    }

    // Update new and changed feeds. Changed feeds may need updating because
    // they may have been unhidden.
    if (newFeeds.length || changedFeeds.length) {
        newFeeds = newFeeds.filter(function(feed) !feed.isFolder);
        if (newFeeds.length) {
            newFeeds = newFeeds.map(function(f) Storage.getFeed(f.feedID));
            FeedUpdateService.updateFeeds(newFeeds);
        }
    }
}.gen();

LivemarksSync.prototype = {

    checkHomeFolder: function BookmarksSync_checkHomeFolder() {
        let folderValid = true;

        if (StorageInternal.homeFolderID == -1) {
            let allFeeds = Storage.getAllFeeds(true);
            for (let feed of allFeeds)
                feed.hidden = Date.now();

            Storage.changeFeedProperties(allFeeds);

            folderValid = false;
        }
        else {
            try {
                // This will throw if the home folder was deleted.
                Bookmarks.getItemTitle(StorageInternal.homeFolderID);
            }
            catch (e) {
                Prefs.clearUserPref('homeFolder');
                folderValid = false;
            }
        }

        return folderValid;
    },

    traversePlacesQueryResults: function BookmarksSync_traversePlacesQueryResults(aContainer, aLivemarks, aCallback) {
        let resume = BookmarksSync_traversePlacesQueryResults.resume;

        aContainer.containerOpen = true;

        for (let i = 0; i < aContainer.childCount; i++) {
            let node = aContainer.getChild(i);

            if (node.type != Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER)
                continue;

            let item = {};
            item.title = Bookmarks.getItemTitle(node.itemId);
            item.rowIndex = aLivemarks.length;

            // Convert the ids to strings ourselves, because when database does it
            // it includes a decimal point in the string representation (e.g. 43523.0).
            item.bookmarkID = node.itemId.toString();
            item.parent = aContainer.itemId.toString();

            let [status, placesItem] = yield Places.livemarks.getLivemark({'id': node.itemId }, resume);

            if (Components.isSuccessCode(status)) {
                item.feedURL = placesItem.feedURI.spec;
                item.feedID = Utils.hashString(item.feedURL);
                item.isFolder = false;

                aLivemarks.push(item);
            }
            else {
                item.feedURL = null;
                item.feedID = node.itemId.toFixed().toString();
                item.isFolder = true;

                aLivemarks.push(item);

                if (node instanceof Ci.nsINavHistoryContainerResultNode)
                    yield this.traversePlacesQueryResults(node, aLivemarks, resume);
            }
        }

        aContainer.containerOpen = false;

        aCallback();
    }.gen()

}


// Cached statements.
let Stm = {

    get getAllFeeds() {
        let sql = 'SELECT feedID, feedURL, websiteURL, title, subtitle, dateModified,   ' +
                  '       favicon, lastUpdated, oldestEntryDate, rowIndex, parent,      ' +
                  '       isFolder, bookmarkID, entryAgeLimit, maxEntries, hidden,      ' +
                  '       updateInterval, markModifiedEntriesUnread, omitInUnread,      ' +
                  '       lastFaviconRefresh '                                            +
                  'FROM feeds                                                           ' +
                  'ORDER BY rowIndex ASC                                                ';
        delete this.getAllFeeds;
        return this.getAllFeeds = new Statement(sql);
    },

    get getAllTags() {
        let sql = 'SELECT DISTINCT entry_tags.tagName                                    '+
                  'FROM entry_tags INNER JOIN entries ON entry_tags.entryID = entries.id '+
                  'WHERE entries.deleted = :deletedState                                 '+
                  'ORDER BY entry_tags.tagName                                           ';
        delete this.getAllTags;
        return this.getAllTags = new Statement(sql, { 'deletedState': Storage.ENTRY_STATE_NORMAL });
    },

    get changeFeedProperties() {
        let sql = 'UPDATE feeds                                  ' +
                  'SET title = :title,                           ' +
                  '    subtitle = :subtitle,                     ' +
                  '    websiteURL = :websiteURL,                 ' +
                  '    hidden = :hidden,                         ' +
                  '    rowIndex = :rowIndex,                     ' +
                  '    parent = :parent,                         ' +
                  '    bookmarkID = :bookmarkID,                 ' +
                  '    favicon = :favicon,                       ' +
                  '    lastUpdated = :lastUpdated,               ' +
                  '    dateModified = :dateModified,             ' +
                  '    oldestEntryDate = :oldestEntryDate,       ' +
                  '    lastFaviconRefresh = :lastFaviconRefresh, ' +
                  '    entryAgeLimit  = :entryAgeLimit,          ' +
                  '    maxEntries =     :maxEntries,             ' +
                  '    updateInterval = :updateInterval,         ' +
                  '    markModifiedEntriesUnread = :markModifiedEntriesUnread, ' +
                  '    omitInUnread = :omitInUnread              ' +
                  'WHERE feedID = :feedID                        ';
        delete this.changeFeedProperties;
        return this.changeFeedProperties = new Statement(sql);
    },

    get setFeedTitle() {
        let sql = 'UPDATE feeds SET title = :title WHERE feedID = :feedID';
        delete this.setFeedTitle;
        return this.setFeedTitle = new Statement(sql);
    },

    get insertEntry() {
        let sql = 'INSERT INTO entries (feedID, primaryHash, secondaryHash, providedID, entryURL, date, updated) ' +
                  'VALUES (:feedID, :primaryHash, :secondaryHash, :providedID, :entryURL, :date, :updated)        ';
        delete this.insertEntry;
        return this.insertEntry = new Statement(sql);
    },

    get insertEntryText() {
        let sql = 'INSERT INTO entries_text (title, content, authors) ' +
                  'VALUES(:title, :content, :authors)   ';
        delete this.insertEntryText;
        return this.insertEntryText = new Statement(sql);
    },

    get updateEntry() {
        let sql = 'UPDATE entries SET read = :read, updated = :updated '+
                  'WHERE id = :id                                             ';
        delete this.updateEntry;
        return this.updateEntry = new Statement(sql);
    },

    get updateEntryText() {
        let sql = 'UPDATE entries_text SET title = :title, content = :content, '+
                  'authors = :authors WHERE rowid = :id                        ';
        delete this.updateEntryText;
        return this.updateEntryText = new Statement(sql);
    },

    get getLastRowids() {
        let sql = 'SELECT rowid FROM entries ORDER BY rowid DESC LIMIT :count';
        delete this.getLastRowids;
        return this.getLastRowids = new Statement(sql);
    },

    get purgeDeletedEntriesText() {
        // Fixed for index mismatch between entries and entries_text
        let sql = 'DELETE FROM entries_text                                                 '+
                  'WHERE rowid IN (                                                         '+
                  '   SELECT entries.id                                                     '+
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID        '+
                  '   WHERE (entries.deleted = :deletedState AND feeds.oldestEntryDate > entries.date) '+
                  '         OR (:currentDate - feeds.hidden > :retentionTime AND feeds.hidden != 0)    '+
                  ') AND rowid <> (SELECT max(rowid) from entries_text)                                ';
        delete this.purgeDeletedEntriesText;
        return this.purgeDeletedEntriesText = new Statement(sql);
    },

    get purgeDeletedEntries() {
        let sql = 'DELETE FROM entries                                                      '+
                  'WHERE id IN (                                                            '+
                  '   SELECT entries.id                                                     '+
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID        '+
                  '   WHERE (entries.deleted = :deletedState AND feeds.oldestEntryDate > entries.date) '+
                  '         OR (:currentDate - feeds.hidden > :retentionTime AND feeds.hidden != 0)    '+
                  ')                                                                                   ';
        delete this.purgeDeletedEntries;
        return this.purgeDeletedEntries = new Statement(sql);
    },

    get purgeDeletedFeeds() {
        let sql = 'DELETE FROM feeds                                      '+
                  'WHERE :currentDate - feeds.hidden > :retentionTime AND '+
                  '      feeds.hidden != 0                                ';
        delete this.purgeDeletedFeeds;
        return this.purgeDeletedFeeds = new Statement(sql);
    },

    get getDeletedEntriesCount() {
        let sql = 'SELECT COUNT(1) AS entryCount FROM entries  ' +
                  'WHERE feedID = :feedID AND                  ' +
                  '      starred = 0 AND                       ' +
                  '      deleted = :deletedState               ';
        delete this.getDeletedEntriesCount;
        return this.getDeletedEntriesCount = new Statement(sql);
    },

    get getEntryByPrimaryHash() {
        let sql = 'SELECT id, date, updated, read FROM entries WHERE primaryHash = :primaryHash';
        delete this.getEntryByPrimaryHash;
        return this.getEntryByPrimaryHash = new Statement(sql);
    },

    get getEntryBySecondaryHash() {
        let sql = 'SELECT id, date, updated, read FROM entries WHERE secondaryHash = :secondaryHash';
        delete this.getEntryBySecondaryHash;
        return this.getEntryBySecondaryHash = new Statement(sql);
    },

    get selectEntriesByURL() {
        let sql = 'SELECT id FROM entries WHERE entryURL = :url';
        delete this.selectEntriesByURL;
        return this.selectEntriesByURL = new Statement(sql);
    },

    get selectEntriesByBookmarkID() {
        let sql = 'SELECT id, entryURL FROM entries WHERE bookmarkID = :bookmarkID';
        delete this.selectEntriesByBookmarkID;
        return this.selectEntriesByBookmarkID = new Statement(sql);
    },

    get selectEntriesByTagName() {
        let sql = 'SELECT id, entryURL FROM entries WHERE id IN (          '+
                  '    SELECT entryID FROM entry_tags WHERE tagName = :tagName '+
                  ')                                                       ';
        delete this.selectEntriesByTagName;
        return this.selectEntriesByTagName = new Statement(sql);
    },

    get starEntry() {
        let sql = 'UPDATE entries SET starred = 1, bookmarkID = :bookmarkID WHERE id = :entryID';
        delete this.starEntry;
        return this.starEntry = new Statement(sql);
    },

    get unstarEntry() {
        let sql = 'UPDATE entries SET starred = 0, bookmarkID = -1 WHERE id = :id';
        delete this.unstarEntry;
        return this.unstarEntry = new Statement(sql);
    },

    get checkTag() {
        let sql = 'SELECT EXISTS (                  '+
                  '    SELECT tagName               '+
                  '    FROM entry_tags              '+
                  '    WHERE tagName = :tagName AND '+
                  '          entryID = :entryID     '+
                  ') AS alreadyTagged               ';
        delete this.checkTag;
        return this.checkTag = new Statement(sql);
    },

    get tagEntry() {
        let sql = 'INSERT INTO entry_tags (entryID, tagName) '+
                  'VALUES (:entryID, :tagName)               ';
        delete this.tagEntry;
        return this.tagEntry = new Statement(sql);
    },

    get untagEntry() {
        let sql = 'DELETE FROM entry_tags WHERE entryID = :entryID AND tagName = :tagName';
        delete this.untagEntry;
        return this.untagEntry = new Statement(sql);
    },

    get getTagsForEntry() {
        let sql = 'SELECT tagName FROM entry_tags WHERE entryID = :entryID';
        delete this.getTagsForEntry;
        return this.getTagsForEntry = new Statement(sql);
    },

    get setSerializedTagList() {
        let sql = 'UPDATE entries_text SET tags = :tags WHERE rowid = :entryID';
        delete this.setSerializedTagList;
        return this.setSerializedTagList = new Statement(sql);
    },

    get insertFeed() {
        let sql = 'INSERT OR IGNORE INTO feeds                                                   ' +
                  '(feedID, feedURL, title, rowIndex, isFolder, parent, bookmarkID)              ' +
                  'VALUES (:feedID, :feedURL, :title, :rowIndex, :isFolder, :parent, :bookmarkID)';
        delete this.insertFeed;
        return this.insertFeed = new Statement(sql);
    }

}


let Utils = {

    getTagsForEntry: function getTagsForEntry(aEntryID, aCallback) {
        Stm.getTagsForEntry.params = { 'entryID': aEntryID };
        Stm.getTagsForEntry.getResultsAsync(function(results) {
            aCallback([row.tagName for (row of results)]);
        })
    },

    getFeedByBookmarkID: function getFeedByBookmarkID(aBookmarkID) {
        for (let feed of Storage.getAllFeeds(true)) {
            if (feed.bookmarkID == aBookmarkID)
                return feed;
        }

        return null;
    },

    isLivemarkStored: function isLivemarkStored(aItemID) {
        return !!Utils.getFeedByBookmarkID(aItemID);
    },

    getEntriesByURL: function getEntriesByURL(aURL, aCallback) {
        Stm.selectEntriesByURL.params.url = aURL;
        Stm.selectEntriesByURL.getResultsAsync(function(results) {
            aCallback([row.id for (row of results)]);
        })
    },

    getEntriesByBookmarkID: function getEntriesByBookmarkID(aBookmarkID, aCallback) {
        Stm.selectEntriesByBookmarkID.params.bookmarkID = aBookmarkID;
        Stm.selectEntriesByBookmarkID.getResultsAsync(function(results) {
            aCallback([{ id: row.id, url: row.entryURL } for (row of results)])
        })
    },

    getEntriesByTagName: function getEntriesByTagName(aTagName, aCallback) {
        Stm.selectEntriesByTagName.params.tagName = aTagName;
        Stm.selectEntriesByTagName.getResultsAsync(function(results) {
            aCallback([row.id for (row of results)]);
        })
    },

    newURI: function(aSpec) {
        try {
            var uri = Services.io.newURI(aSpec, null, null);
        }
        catch (ex) {
            uri = null;
        }
        return uri;
    },

    isBookmark: function(aItemID) {
        return (Bookmarks.getItemType(aItemID) === Bookmarks.TYPE_BOOKMARK);
    },

    isNormalBookmark: function Utils_isNormalBookmark(aItemID, aCallback) {
        let resume = Utils_isNormalBookmark.resume;
        let parent = Bookmarks.getFolderIdForItem(aItemID);
        aCallback(!Utils.isTagFolder(parent) && !(yield Utils.isLivemark(parent, resume)));
    }.gen(),

    isLivemark: function Utils_isLivemark(aItemID, aCallback) {
        let resume = Utils_isLivemark.resume;
        aCallback(Components.isSuccessCode(yield Places.livemarks.getLivemark({"id": aItemID}, function(status) resume(status))));
    }.gen(),

    isFolder: function(aItemID) {
        return (Bookmarks.getItemType(aItemID) === Bookmarks.TYPE_FOLDER);
    },

    isTagFolder: function(aItemID) {
        return (Bookmarks.getFolderIdForItem(aItemID) === Places.tagsFolderId);
    },

    // Returns TRUE if an item is a subfolder of Brief's home folder.
    isInHomeFolder: function(aItemID) {
        let homeID = StorageInternal.homeFolderID;
        if (homeID === -1)
            return false;

        if (homeID === aItemID)
            return true;

        let inHome = false;
        let parent = aItemID;
        while (parent !== Places.placesRootId) {
            parent = Bookmarks.getFolderIdForItem(parent);
            if (parent === homeID) {
                inHome = true;
                break;
            }
        }

        return inHome;
    },

    hashString: function(aString) {
        // nsICryptoHash can read the data either from an array or a stream.
        // Creating a stream ought to be faster than converting a long string
        // into an array using JS.
        let unicodeConverter = Cc['@mozilla.org/intl/scriptableunicodeconverter'].
                               createInstance(Ci.nsIScriptableUnicodeConverter);
        unicodeConverter.charset = 'UTF-8';
        let stream = unicodeConverter.convertToInputStream(aString);

        let hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
        hasher.init(Ci.nsICryptoHash.MD5);
        hasher.updateFromStream(stream, stream.available());
        let hash = hasher.finish(false);

        // Convert the hash to a hex-encoded string.
        let hexchars = '0123456789ABCDEF';
        let hexrep = new Array(hash.length * 2);
        for (let i = 0; i < hash.length; ++i) {
            hexrep[i * 2] = hexchars.charAt((hash.charCodeAt(i) >> 4) & 15);
            hexrep[i * 2 + 1] = hexchars.charAt(hash.charCodeAt(i) & 15);
        }
        return hexrep.join('');
    }

}


StorageInternal.init();
