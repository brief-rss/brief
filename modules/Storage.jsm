const EXPORTED_SYMBOLS = ['Storage', 'Query'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/StorageUtils.jsm');
Components.utils.import('resource://brief/FeedContainer.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/FileUtils.jsm');
Components.utils.import('resource://gre/modules/commonjs/sdk/core/promise.js');
Components.utils.import('resource://gre/modules/Task.jsm');

IMPORT_COMMON(this);


const PURGE_ENTRIES_INTERVAL = 3600*24; // 1 day
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // 1 week
const LIVEMARKS_SYNC_DELAY = 100;
const BACKUP_FILE_EXPIRATION_AGE = 3600*24*14; // 2 weeks
const DATABASE_VERSION = 18;
const DATABASE_CACHE_SIZE = 256; // With the default page size of 32KB, it gives us 8MB of cache memory.

const FEEDS_TABLE_SCHEMA = [
    'feedID          TEXT UNIQUE',
    'feedURL         TEXT',
    'websiteURL      TEXT',
    'title           TEXT',
    'subtitle        TEXT',
    'language        TEXT',
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
    'omitInUnread    INTEGER DEFAULT 0', /* This is a misnomer, should be called omitInGlobalViews */
    'viewMode        INTEGER DEFAULT 0' /* 0 - full view, 1 - headlines view */
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


XPCOMUtils.defineLazyModuleGetter(this, 'FeedUpdateService', 'resource://brief/FeedUpdateService.jsm');
XPCOMUtils.defineLazyServiceGetter(this, 'Bookmarks', '@mozilla.org/browser/nav-bookmarks-service;1', 'nsINavBookmarksService');

XPCOMUtils.defineLazyGetter(this, 'Prefs', () => {
    return Services.prefs.getBranch('extensions.brief.');
})
XPCOMUtils.defineLazyGetter(this, 'Places', () => {
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
     * A promise that resolves when storage is initiated.
     *
     * @returns Promise<null>
     */
    get ready() {
        return StorageInternal.ready;
    },

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
     * @returns Promise<array> Array of tag names.
     */
    getAllTags: function() {
        return StorageInternal.getAllTags();
    },

    /**
     * Evaluates a feed, updating its properties, as well as inserting
     * and updating its entries.
     *
     * @param aFeedID
     *         ID of the feed to process.
     * @param aParsedFeed
     *        nsIFeed object returned by the parser.
     * @param aXMLDocument
     *        The feed's DOM document.
     * @returns Promise<integer> Number of newly inserted entries.
     */
    processFeed: function(aFeedID, aParsedFeed, aFeedDocument) {
        return StorageInternal.processFeed(aFeedID, aParsedFeed, aFeedDocument);
    },

    /**
     * Updates feed properties and settings. Cache is updated immediatelly.
     *
     * @param aPropertyBags
     *        An object or an array of objects containing a feedID property and name-value
     *        pairs of properties to update. Invalid properties are ignored.
     */
    changeFeedProperties: function(aPropertyBags) {
        return StorageInternal.changeFeedProperties(aPropertyBags);
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

    // See Storage.
    get ready() this.deferredReady.promise,

    deferredReady: Promise.defer(),

    feedCache: null,


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
            yield this.setupDatabase();
        }
        else if (databaseIsNew) {
            yield this.setupDatabase();
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
                yield this.setupDatabase();
            }
            else {
                yield this.upgradeDatabase();
            }
        }

        yield new Statement('PRAGMA cache_size = ' + DATABASE_CACHE_SIZE).executeAsync();

        // Build feed cache.
        this.feedCache = [];
        for (let row of yield Stm.getAllFeeds.getResultsAsync()) {
            let feed = new Feed();
            for (let column in row)
                feed[column] = row[column];

            this.feedCache.push(feed);
        }

        this.homeFolderID = Prefs.getIntPref('homeFolder');
        Prefs.addObserver('', this, false);

        Services.obs.addObserver(this, 'quit-application', false);
        Services.obs.addObserver(this, 'idle-daily', false);

        try {
            Bookmarks.addObserver(BookmarkObserver, false);
        }
        finally {
            this.deferredReady.resolve();
        }
    }.task(),

    setupDatabase: function Database_setupDatabase() {
        let sqlStrings = [
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
        ]

        for (let sql of sqlStrings)
            yield new Statement(sql).executeAsync();

        Connection.schemaVersion = DATABASE_VERSION;
    }.task(),

    upgradeDatabase: function StorageInternal_upgradeDatabase() {
        let sqlStrings = [];

        switch (Connection.schemaVersion) {
            // To 1.5b2
            case 9:
                // Remove dead rows from entries_text.
                sqlStrings.push('DELETE FROM entries_text                       '+
                                'WHERE rowid IN (                               '+
                                '     SELECT entries_text.rowid                 '+
                                '     FROM entries_text LEFT JOIN entries       '+
                                '          ON entries_text.rowid = entries.id   '+
                                '     WHERE NOT EXISTS (                        '+
                                '         SELECT id                             '+
                                '         FROM entries                          '+
                                '         WHERE entries_text.rowid = entries.id '+
                                '     )                                         '+
                               ')  AND rowid <> (SELECT max(rowid) from entries_text)');

            // To 1.5b3
            case 10:
                sqlStrings.push('ALTER TABLE feeds ADD COLUMN lastFaviconRefresh INTEGER DEFAULT 0');

            // To 1.5
            case 11:
                sqlStrings.push('ANALYZE');

            // These were for one-time fixes on 1.5 branch.
            case 12:
            case 13:

            // To 1.6.
            case 14:
                sqlStrings.push('PRAGMA journal_mode=WAL');

            // To 1.7b1
            case 15:
                sqlStrings.push('ALTER TABLE feeds ADD COLUMN omitInUnread INTEGER DEFAULT 0');

            // To 1.7. One-time fix for table corruption.
            case 16:
                sqlStrings.push(
                    'DELETE FROM entries WHERE rowid NOT IN (SELECT docid FROM entries_text)',
                    'DELETE FROM entries_text WHERE docid NOT IN (SELECT rowid FROM entries)',
                    'INSERT OR IGNORE INTO entries_text(rowid) SELECT seq FROM sqlite_sequence WHERE name=\'entries\''
                );

            // To 2.0.
            case 17:
                sqlStrings.push('ALTER TABLE feeds ADD COLUMN language TEXT');
                sqlStrings.push('ALTER TABLE feeds ADD COLUMN viewMode INTEGER DEFAULT 0');
        }

        for (let sql of sqlStrings)
            yield new Statement(sql).executeAsync();

        Connection.schemaVersion = DATABASE_VERSION;
    }.task(),


    // See Storage.
    getFeed: function StorageInternal_getFeed(aFeedID) {
        for (let feed of this.getAllFeeds(true, true)) {
            if (feed.feedID == aFeedID)
                return feed;
        }

        return null;
    },


    // See Storage.
    getAllFeeds: function StorageInternal_getAllFeeds(aIncludeFolders, aIncludeInactive) {
        return this.feedCache.filter(
            f => (!f.isFolder || aIncludeFolders) && (!f.hidden || aIncludeInactive)
        )
    },


    // See Storage.
    getAllTags: function StorageInternal_getAllTags() {
        return Stm.getAllTags.getResultsAsync().then(
            results => [row.tagName for (row of results)]
        )
    },


    // See Storage.
    processFeed: function StorageInternal_processFeed(aFeedID, aParsedFeed, aFeedDocument) {
        new FeedProcessor(aFeedID, aParsedFeed, aFeedDocument);
    },

    /**
     * Inserts one or more feeds into the database, updates cache,
     * and sends notifications.
     *
     * @param aFeeds <object> or <array <object>>
     *        An object or an array of objects containing the following properties:
     *        feedID, feedURL, title, rowIndex, isFolder, parent, bookmarkID.
     */
    addFeeds: function StorageInternal_addFeeds(aItems) {
        let items = Array.isArray(aItems) ? aItems : [aItems];

        for (let feedData of items) {
            Stm.insertFeed.paramSets.push({
                'feedID'    : feedData.feedID,
                'feedURL'   : feedData.feedURL || null,
                'title'     : feedData.title,
                'rowIndex'  : feedData.rowIndex,
                'isFolder'  : feedData.isFolder ? 1 : 0,
                'parent'    : feedData.parent,
                'bookmarkID': feedData.bookmarkID
            })

            // Update cache.
            let feed = new Feed();
            for (let property in feedData)
                feed[property] = feedData[property];

            this.feedCache.push(feed);
        }

        this.feedCache = this.feedCache.sort((a, b) => a.rowIndex - b.rowIndex);

        Stm.insertFeed.executeAsync().then(() => {
            feeds = items.filter(item => !item.isFolder)
                         .map(item => Storage.getFeed(item.feedID));
            FeedUpdateService.updateFeeds(feeds);
        })

        Services.obs.notifyObservers(null, 'brief:invalidate-feedlist', '');
    },

    // See Storage.
    changeFeedProperties: function StorageInternal_changeFeedProperties(aPropertyBags) {
        let propertyBags = Array.isArray(aPropertyBags) ? aPropertyBags : [aPropertyBags];

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
                            case 'rowIndex':
                                this.feedCache = this.feedCache.sort(
                                    (a, b) => a.rowIndex - b.rowIndex
                                )
                                // Fall through...

                            case 'hidden':
                            case 'parent':
                            case 'title':
                            case 'omitInUnread':
                            case 'language':
                                invalidateFeedlist = true;
                                break;

                            case 'entryAgeLimit':
                                this.expireEntries(cachedFeed);
                                break;

                            case 'favicon':
                                Services.obs.notifyObservers(null, 'brief:feed-favicon-changed',
                                                             cachedFeed.feedID);
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

        if (invalidateFeedlist)
            Services.obs.notifyObservers(null, 'brief:invalidate-feedlist', '');

        Stm.changeFeedProperties.executeAsync();
    },

    /**
     * Moves entries to Trash if they exceed the age limit or the number limit.
     *
     * @param aFeed [optional]
     *        The feed whose entries to expire. If not provided, all feeds are processed.
     */
    expireEntries: function StorageInternal_expireEntries(aFeed) {
        let feeds = aFeed ? [aFeed] : this.getAllFeeds();

        let feedsWithAgeLimit = feeds.filter(f => f.entryAgeLimit);
        let feedsWithoutAgeLimit = feeds.filter(f => !f.entryAgeLimit);

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

                yield query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
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

            yield query.deleteEntries(Storage.ENTRY_STATE_TRASHED);
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
    }.task(),

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
                                 Stm.purgeDeletedFeeds]);

        // Prefs can only store longs while Date is a long long.
        let now = Math.round(Date.now() / 1000);
        Prefs.setIntPref('database.lastPurgeTime', now);
    },

    // nsIObserver
    observe: function StorageInternal_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'quit-application':
                for each (let statement in Stm)
                    statement._nativeStatement.finalize();

                Connection._nativeConnection.asyncClose();

                Bookmarks.removeObserver(BookmarkObserver);
                Prefs.removeObserver('', this);

                Services.obs.removeObserver(this, 'quit-application');
                Services.obs.removeObserver(this, 'idle-daily');
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
        if (aState) {
            Stm.starEntry.params = { 'bookmarkID': aBookmarkID, 'entryID': aEntryID };
            yield Stm.starEntry.executeAsync();
        }
        else {
            Stm.unstarEntry.params = { 'id': aEntryID };
            yield Stm.unstarEntry.executeAsync();
        }

        if (!aDontNotify) {
            let list = yield new Query(aEntryID).getEntryList();
            for (let observer of StorageInternal.observers) {
                if (observer.onEntriesStarred)
                    observer.onEntriesStarred(list, aState);
            }
        }
    }.task(),

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
        let params = { 'entryID': aEntryID, 'tagName': aTagName };

        if (aState) {
            Stm.checkTag.params = params;
            let results = yield Stm.checkTag.getResultsAsync();
            if (results[0].alreadyTagged)
                return;

            Stm.tagEntry.params = params;
            yield Stm.tagEntry.executeAsync();
        }
        else {
            Stm.untagEntry.params = params;
            yield Stm.untagEntry.executeAsync();
        }

        // Update the serialized list of tags stored in entries_text table.
        let newTags = yield Utils.getTagsForEntry(aEntryID);
        Stm.setSerializedTagList.params = {
            'tags': newTags.join(', '),
            'entryID': aEntryID
        }
        yield Stm.setSerializedTagList.executeAsync();

        let list = yield new Query(aEntryID).getEntryList();
        for (let observer of StorageInternal.observers) {
            if (observer.onEntriesTagged)
                observer.onEntriesTagged(list, aState, aTagName);
        }
    }.task(),

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver])

}


// See Storage.processFeed().
function FeedProcessor(aFeedID, aParsedFeed, aFeedDocument) {
    this.feed = Storage.getFeed(aFeedID);
    this.parsedFeed = aParsedFeed;
    this.deferred = Promise.defer();

    let newDateModified = new Date(aParsedFeed.updated).getTime();
    let prevDateModified = this.feed.dateModified;

    let hasItems = aParsedFeed.items && aParsedFeed.items.length;
    if (hasItems && (!newDateModified || newDateModified > prevDateModified)) {
        this.remainingEntriesCount = aParsedFeed.items.length;
        this.newOldestEntryDate = Date.now();

        this.updatedEntries = [];

        this.updateEntry = Stm.updateEntry.clone();
        this.insertEntry = Stm.insertEntry.clone();
        this.updateEntryText = Stm.updateEntryText.clone();
        this.insertEntryText = Stm.insertEntryText.clone();

        // Counting down, because the order of items is reversed after parsing.
        for (let i = aParsedFeed.items.length - 1; i >= 0; i--) {
            let parsedEntry = aParsedFeed.items.queryElementAt(i, Ci.nsIFeedEntry);
            this.processEntry(new Entry(parsedEntry));
        }
    }
    else {
        this.deferred.resolve(0);
    }

    Storage.changeFeedProperties({
        feedID: aFeedID,
        websiteURL: aParsedFeed.link ? aParsedFeed.link.spec : '',
        subtitle: aParsedFeed.subtitle ? aParsedFeed.subtitle.text : '',
        oldestEntryDate: this.newOldestEntryDate || this.feed.oldestEntryDate,
        language: aParsedFeed.fields.get('language') ||
                  aFeedDocument.documentElement.getAttribute('xml:lang'),
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
        let generator = this.parsedFeed.generator;
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

        select.executeAsync(
            row => {
                storedID = row.id;
                storedPubDate = row.date;
                storedDateUpdated = row.updated;
                isEntryRead = row.read;
            }
        ).then(
            reason => {
                if (reason == REASON_FINISHED) {
                    if (storedID) {
                        // XXX Comparing storedPubDate is temporary. Done to avoid suddenly
                        // marking many entries as update for old users (before rev 1.72).
                        if (aEntry.updated && aEntry.updated > storedDateUpdated
                                           && aEntry.updated > storedPubDate) {
                            this.addUpdateParams(aEntry, storedID, isEntryRead);
                        }
                    }
                    else {
                        this.addInsertParams(aEntry, primaryHash, secondaryHash);
                    }
                }

                if (!--this.remainingEntriesCount)
                    this.executeAndNotify();
            },

            error => Cu.reportError(error)
        )
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
        let insertedEntries = [];

        if (this.insertEntry.paramSets.length) {
            if (this.insertEntry.paramSets.length != this.insertEntryText.paramSets.length) {
                this.deferred.resolve(0);
                throw new Error('Mismatched parameteres between insertEntry and insertEntryText statements.');
            }

            Stm.getLastRowids.params.count = this.insertEntry.paramSets.length;
            let statements = [this.insertEntry, this.insertEntryText, Stm.getLastRowids];

            let reason = yield Connection.executeAsync(
                statements,
                row => insertedEntries.push(row.id)
            )

            if (reason === REASON_FINISHED) {
                let list = yield new Query(insertedEntries).getEntryList();
                for (let observer of StorageInternal.observers) {
                    if (observer.onEntriesAdded)
                        observer.onEntriesAdded(list);
                }

                StorageInternal.expireEntries(this.feed);
            }
        }

        if (this.updateEntry.paramSets.length) {
            let statements = [this.updateEntry, this.updateEntryText];

            yield Connection.executeAsync(statements);

            let list = yield new Query(this.updatedEntries).getEntryList();
            for (let observer of StorageInternal.observers) {
                if (observer.onEntriesUpdated)
                    observer.onEntriesUpdated(list);
            }
        }

        this.deferred.resolve(insertedEntries.length);
    }.task()

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
     * Include feeds that the user marked as excluded from global views.
     */
    includeFeedsExcludedFromGlobalViews: true,

    /**
     * Indicates if there are any entries that match this query.
     *
     * @returns Promise<boolean>
     */
    hasMatches: function Query_hasMatches() {
        let sql = 'SELECT EXISTS (SELECT entries.id ' + this._getQueryString(true) + ') AS found';

        return new Statement(sql).getResultsAsync().then(
            results => results[0].found,
            error => {
                this._maybeThrow(error);
                return false;
            }
        )
    },

    /**
     * Get a simple list of entries.
     * XXX Check performance.
     *
     * @returns Promise<array> Array of entry IDs.
     */
    getEntries: function Query_getEntries() {
        let sql = 'SELECT entries.id ' + this._getQueryString(true);

        return new Statement(sql).getResultsAsync().then(
            results => [row.id for (row of results)],
		    error => {
                this._maybeThrow(error);
                return [];
            }
        )
    },


    /**
     * Get entries with all their properties.
     *
     * @returns Promise<array> Array of Entry objects.
     */
    getFullEntries: function Query_getFullEntries() {
        let sql = 'SELECT entries.id, entries.feedID, entries.entryURL, entries.date,   '+
                  '       entries.read, entries.starred, entries.updated,               '+
                  '       entries.bookmarkID, entries_text.title, entries_text.content, '+
                  '       entries_text.authors, entries_text.tags                       ';
        sql += this._getQueryString(true, true);

        return new Statement(sql).getResultsAsync().then(
            results => {
                let entries = [];
                for (let row of results) {
                    let entry = new Entry();

                    for (let column in row)
                        entry[column] = row[column]

                    entry.markedUnreadOnUpdate = row['read'] == 2;
                    entry.read = row['read'] == 1;

                    entries.push(entry);
                }

                return entries;
            },

            error => {
                this._maybeThrow(error);
                return [];
            }
        )
    },


    /**
     * Get values of a single property of each of the entries.
     *
     * @param aPropertyName
     *        Name of the property.
     * @param aDistinct
     *        Don't include multiple entries with the same value.
     * @returns Promise<array> Array of values of the requested property.
     */
    getProperty: function Query_getProperty(aPropertyName, aDistinct) {
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

        return new Statement(sql).executeAsync(
            row => {
                let value = row[aPropertyName];
                if (!aDistinct || values.indexOf(value) == -1)
                    values.push(value);
            }
        ).then(
            () => values,
            error => {
                this._maybeThrow(error);
                return values;
            }
        )
    },


    /**
     * Get the number of selected entries.
     *
     * @returns Promise<number>
     */
    getEntryCount: function Query_getEntryCount() {
        // Optimization: don't sort.
        let tempOrder = this.sortOrder;
        this.sortOrder = undefined;

        let sql = 'SELECT COUNT(1) AS count ' + this._getQueryString(true);

        this.sortOrder = tempOrder;

        return new Statement(sql).getResultsAsync().then(
            results => results[0].count,
            error => {
                this._maybeThrow(error);
                return 0;
            }
        )
    },


    /**
     * Get a list of entries.
     *
     * @returns Promise<EntryList>
     */
    getEntryList: function Query_getEntryList() {
        let entryIDs = [];
        let feedIDs = [];
        let tags = [];

        let tempHidden = this.includeHiddenFeeds;
        this.includeHiddenFeeds = false;
        let sql = 'SELECT entries.id, entries.feedID, entries_text.tags '
                   + this._getQueryString(true, true);
        this.includeHiddenFeeds = tempHidden;

        return new Statement(sql).executeAsync(
            row => {
                entryIDs.push(row.id);

                if (feedIDs.indexOf(row.feedID) == -1)
                    feedIDs.push(row.feedID);

                if (row.tags) {
                    let arr = row.tags.split(', ');
                    let newTags = arr.filter(t => tags.indexOf(t) === -1);
                    tags = tags.concat(newTags);
                }
            }
        ).then(
            reason => {
                let list = new EntryList();
                list.IDs = entryIDs;
                list.feedIDs = feedIDs;
                list.tags = tags;

                return list;
            },
            error => {
                this._maybeThrow(error);
                return new EntryList();
            }
        )
    },


    /**
     * Mark entries as read/unread.
     *
     * @param aState
     *        New state of entries (TRUE for read, FALSE for unread).
     * @returns Promise<null>
     */
    markEntriesRead: function Query_markEntriesRead(aState) {
        // Try not to include entries which already have the desired state,
        // but we can't omit them if a specific range of the selected entries
        // is meant to be marked.
        let tempRead = this.read;
        if (!this.limit && !this.offset)
            this.read = !aState;

        let list = yield this.getEntryList();

        if (list.length) {
            let sql = 'UPDATE entries SET read = :read ';
            let update = new Statement(sql + this._getQueryString());

            update.params.read = aState ? 1 : 0;
            yield update.executeAsync();

            this.read = tempRead;

            for (let observer of StorageInternal.observers) {
                if (observer.onEntriesMarkedRead)
                    observer.onEntriesMarkedRead(list, aState);
            }
        }
        else {
            this.read = tempRead;
        }
    }.task(),

    /**
     * Set the deleted state of the selected entries or remove them from the database.
     *
     * @param aState
     *        The new deleted state (as defined by constants in Storage).
     * @returns Promise<null>
     */
    deleteEntries: function Query_deleteEntries(aState) {
        let list = yield this.getEntryList();
        if (list.length) {
            let sql = 'UPDATE entries SET deleted = ' + aState + this._getQueryString();
            yield new Statement(sql).executeAsync();

            for (let observer of StorageInternal.observers) {
                if (observer.onEntriesDeleted)
                    observer.onEntriesDeleted(list, aState);
            }
        }
    }.task(),


    /**
     * Bookmark/unbookmark URLs of the selected entries.
     *
     * This function bookmarks URIs of the selected entries. It doesn't star the entries
     * in the database or send notifications - that part is performed by the bookmark
     * observer.
     *
     * @param aState
     *        New state of entries. TRUE to bookmark, FALSE to unbookmark.
     * @returns Promise<null>
     */
    bookmarkEntries: function Query_bookmarkEntries(aState) {
        let transactions = [];

        for (let entry of yield this.getFullEntries()) {
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
                                 if (yield Utils.isNormalBookmark(b))];
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
    }.task(),

    /**
     * Verifies entries' starred statuses and their tags.
     *
     * This function syncs the entry status with user's bookmarks, in case it went
     * out of sync, for example if Brief was disabled or uninstalled.
     *
     * @returns Promise<null>
     */
    verifyBookmarksAndTags: function Query_verifyBookmarksAndTags() {
        for (let entry of yield this.getFullEntries()) {
            let uri = Utils.newURI(entry.entryURL);
            if (!uri)
                return;

            let allBookmarks = Bookmarks.getBookmarkIdsForURI(uri, {});

            // Verify bookmarks.
            let normalBookmarks = [b for (b of allBookmarks) if (yield Utils.isNormalBookmark(b))];
            if (entry.starred && !normalBookmarks.length)
                StorageInternal.starEntry(false, entry.id);
            else if (!entry.starred && normalBookmarks.length)
                StorageInternal.starEntry(true, entry.id, normalBookmarks[0]);

            // Verify tags.
            let storedTags = yield Utils.getTagsForEntry(entry.id);
            let currentTags = allBookmarks.map(id => Bookmarks.getFolderIdForItem(id))
                                          .filter(Utils.isTagFolder)
                                          .map(id => Bookmarks.getItemTitle(id));

            for (let tag of storedTags) {
                if (currentTags.indexOf(tag) === -1)
                    StorageInternal.tagEntry(false, entry.id, tag);
            }

            for (let tag of currentTags) {
                if (storedTags.indexOf(tag) === -1)
                    StorageInternal.tagEntry(true, entry.id, tag);
            }
        }
    }.task(),


    /**
     * Actual list of folders selected by the query, including subfolders
     * of folders specified by Query.folders.
     */
    _effectiveFolders: null,

    /**
     * Check if the given error should be ignored. If so, resolves the provided promise
     * to the default value, otherwise rejects the promise.
     *
     * XXX Is this still necessary?
     */
    _maybeThrow: function BriefQuery__maybeThrow(aError) {
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

        if (!this.includeFeedsExcludedFromGlobalViews)
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
        if (aItemType == Bookmarks.TYPE_FOLDER && Utils.isInHomeFolder(aParentID)) {
            this.delayedLivemarksSync();
            return;
        }

        // Only care about plain bookmarks and tags.
        if (aItemType != Bookmarks.TYPE_BOOKMARK || (yield Utils.isLivemark(aParentID)))
            return;

        // Find entries with the same URI as the added item and tag or star them.
        for (let entry of yield Utils.getEntriesByURL(aURI.spec)) {
            if (Utils.isTagFolder(aParentID)) {
                let tagName = Bookmarks.getItemTitle(aParentID);
                StorageInternal.tagEntry(true, entry, tagName);
            }
            else {
                StorageInternal.starEntry(true, entry, aItemID);
            }
        }
    }.task(),


    // nsINavBookmarkObserver
    onItemRemoved: function BookmarkObserver_onItemRemoved(aItemID, aParentID, aIndex, aItemType, aURI) {
        if (Utils.isLivemarkStored(aItemID) || aItemID == StorageInternal.homeFolderID) {
            this.delayedLivemarksSync();
            return;
        }

        // Obtain parent title and type before any async calls, as the parent may be
        // removed before the function resumes.
        let parentTitle = Bookmarks.getItemTitle(aParentID);
        let isTag = Utils.isTagFolder(aParentID);

        // Only care about plain bookmarks and tags.
        if (aItemType != Bookmarks.TYPE_BOOKMARK || (yield Utils.isLivemark(aParentID)))
            return;


        if (isTag) {
            for (let entry of yield Utils.getEntriesByURL(aURI.spec))
                StorageInternal.tagEntry(false, entry, parentTitle);
        }
        else {
            let entries = yield Utils.getEntriesByBookmarkID(aItemID);

            // Look for other bookmarks for this URI. If there is another
            // bookmark for this URI, don't unstar the entry, but update
            // its bookmarkID to point to that bookmark.
            if (entries.length) {
                let uri = Utils.newURI(aURI.spec);
                var bookmarks = [b for (b of Bookmarks.getBookmarkIdsForURI(uri, {}))
                                 if (yield Utils.isNormalBookmark(b))];
            }

            for (let entry of entries) {
                if (bookmarks.length)
                    StorageInternal.starEntry(true, entry.id, bookmarks[0], true);
                else
                    StorageInternal.starEntry(false, entry.id);
            }
        }
    }.task(),

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
        switch (aProperty) {
            case 'title':
                let feed = Utils.getFeedByBookmarkID(aItemID);
                if (feed) {
                    Stm.setFeedTitle.params = { 'title': aNewValue, 'feedID': feed.feedID };
                    yield Stm.setFeedTitle.executeAsync();
                    feed.title = aNewValue; // Update cache.
                    Services.obs.notifyObservers(null, 'brief:feed-title-changed', feed.feedID);
                }
                else if (Utils.isTagFolder(aItemID)) {
                    this.renameTag(aItemID, aNewValue);
                }
                break;

            case 'uri':
                // Unstar any entries with the old URI.
                for (let entry of yield Utils.getEntriesByBookmarkID(aItemID))
                    StorageInternal.starEntry(false, entry.id);

                // Star any entries with the new URI.
                for (let entry of yield Utils.getEntriesByURL(aNewValue))
                    StorageInternal.starEntry(true, entry, aItemID);

                break;
        }
    }.task(),

    // nsINavBookmarkObserver
    onItemVisited: function BookmarkObserver_aOnItemVisited(aItemID, aVisitID, aTime) { },

    delayedLivemarksSync: function BookmarkObserver_delayedLivemarksSync() {
        if (this.batching) {
            this.homeFolderContentModified = true;
        }
        else {
            if (this.syncDelay)
                this.syncDelay.cancel();

            this.syncDelay = wait(LIVEMARKS_SYNC_DELAY);
            this.syncDelay.then(() => {
                this.syncDelay = null;
                Storage.syncWithLivemarks();
            })
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
        // Get bookmarks in the renamed tag folder.
        let options = Places.history.getNewQueryOptions();
        let query = Places.history.getNewQuery();
        query.setFolders([aTagFolderID], 1);
        let result = Places.history.executeQuery(query, options);
        result.root.containerOpen = true;

        for (let i = 0; i < result.root.childCount; i++) {
            let tagID = result.root.getChild(i).itemId;
            let uri = Bookmarks.getBookmarkURI(tagID);

            for (let entryID of yield Utils.getEntriesByURL(uri.spec)) {
                StorageInternal.tagEntry(true, entryID, aNewName);

                let currentTags = Bookmarks.getBookmarkIdsForURI(uri, {})
                                           .map(id => Bookmarks.getFolderIdForItem(id))
                                           .filter(Utils.isTagFolder)
                                           .map(id => Bookmarks.getItemTitle(id));

                let storedTags = yield Utils.getTagsForEntry(entryID);

                let removedTags = storedTags.filter(t => currentTags.indexOf(t) === -1);

                for (let tag of removedTags)
                    StorageInternal.tagEntry(false, entryID, tag);
            }
        }

        result.root.containerOpen = false;
    }.task(),

    QueryInterface: XPCOMUtils.generateQI([Ci.nsINavBookmarkObserver])

}


/**
 * Synchronizes the list of feeds stored in the database with
 * the livemarks available in the Brief's home folder.
 */
let LivemarksSync = function LivemarksSync() {
    if (!this.checkHomeFolder())
        return;

    let livemarks = [];

    // Get a list of folders and Live Bookmarks in the user's home folder.
    let options = Places.history.getNewQueryOptions();
    let query = Places.history.getNewQuery();
    query.setFolders([StorageInternal.homeFolderID], 1);
    options.excludeItems = true;
    let result = Places.history.executeQuery(query, options);
    yield this.traversePlacesQueryResults(result.root, livemarks);

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
            if (feed.hidden || properties.some(p => feed[p] != livemark[p])) {
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
            newFeeds.push(livemark);
        }
    }

    // Hide any feeds that are no longer found among the livemarks.
    let missingFeeds = storedFeeds.filter(f => oldFeeds.indexOf(f) == -1 && !f.hidden);
    for (let feed of missingFeeds) {
        changedFeeds.push({
            'feedID': feed.feedID,
            'hidden': Date.now()
        });
    }

    if (newFeeds.length)
        StorageInternal.addFeeds(newFeeds);

    if (changedFeeds.length)
        Storage.changeFeedProperties(changedFeeds);
}.task();

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

    /**
     * Recursivesly traverses a bookmark folder and builds a list of
     * all livemarks and folders in it.
     *
     * @param aContainer <nsINavHistoryContainerResultNode>
     *        The folder to traverse.
     * @param aLivemarks <array>
     *        Array to which to append found items.
     * @returns Promise<null>
     */
    traversePlacesQueryResults: function BookmarksSync_traversePlacesQueryResults(aContainer, aLivemarks) {
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

            let deferred = Promise.defer();
            Places.livemarks.getLivemark(
                { 'id': node.itemId },
                (status, placesItem) => deferred.resolve([status, placesItem])
            )
            let [status, placesItem] = yield deferred.promise;

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
                    yield this.traversePlacesQueryResults(node, aLivemarks);
            }
        }

        aContainer.containerOpen = false;
    }.task()

}


// Cached statements.
let Stm = {

    get getAllFeeds() {
        let sql = 'SELECT feedID, feedURL, websiteURL, title, subtitle, dateModified,   ' +
                  '       favicon, lastUpdated, oldestEntryDate, rowIndex, parent,      ' +
                  '       isFolder, bookmarkID, entryAgeLimit, maxEntries, hidden,      ' +
                  '       updateInterval, markModifiedEntriesUnread, omitInUnread,      ' +
                  '       lastFaviconRefresh, language, viewMode                        ' +
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
                  '    language = :language,                     ' +
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
                  '    omitInUnread = :omitInUnread,             ' +
                  '    viewMode = :viewMode                      ' +
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

    getTagsForEntry: function getTagsForEntry(aEntryID) {
        Stm.getTagsForEntry.params = { 'entryID': aEntryID };
        return Stm.getTagsForEntry.getResultsAsync().then(
            results => [row.tagName for (row of results)]
        )
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

    getEntriesByURL: function getEntriesByURL(aURL) {
        Stm.selectEntriesByURL.params.url = aURL;
        return Stm.selectEntriesByURL.getResultsAsync().then(
            results => [row.id for (row of results)]
        )
    },

    getEntriesByBookmarkID: function getEntriesByBookmarkID(aBookmarkID) {
        Stm.selectEntriesByBookmarkID.params.bookmarkID = aBookmarkID;
        return Stm.selectEntriesByBookmarkID.getResultsAsync().then(
            results => [{ id: row.id, url: row.entryURL } for (row of results)]
        )
    },

    getEntriesByTagName: function getEntriesByTagName(aTagName, aCallback) {
        Stm.selectEntriesByTagName.params.tagName = aTagName;
        Stm.selectEntriesByTagName.getResultsAsync(
            results => aCallback([row.id for (row of results)])
        )
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

    isNormalBookmark: function Utils_isNormalBookmark(aItemID) {
        let parent = Bookmarks.getFolderIdForItem(aItemID);
        throw new Task.Result(!Utils.isTagFolder(parent) && !(yield Utils.isLivemark(parent)));
    }.task(),

    isLivemark: function Utils_isLivemark(aItemID) {
        let deferred = Promise.defer();

        Places.livemarks.getLivemark(
            { 'id': aItemID },
            status => deferred.resolve(Components.isSuccessCode(status))
        )

        return deferred.promise;
    },

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
