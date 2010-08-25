var EXPORTED_SYMBOLS = ['Storage', 'Query'];

const Cc = Components.classes;
const Ci = Components.interfaces;

const PURGE_ENTRIES_INTERVAL = 3600*24; // 1 day
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // 1 week
const LIVEMARKS_SYNC_DELAY = 100;
const BACKUP_FILE_EXPIRATION_AGE = 3600*24*14; // 2 weeks
const DATABASE_VERSION = 10;

const FEEDS_TABLE_SCHEMA = [
    'feedID          TEXT UNIQUE',
    'feedURL         TEXT',
    'websiteURL      TEXT',
    'title           TEXT',
    'subtitle        TEXT',
    'imageURL        TEXT',
    'imageLink       TEXT',
    'imageTitle      TEXT',
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
    'markModifiedEntriesUnread INTEGER DEFAULT 1'
]

const ENTRIES_TABLE_SCHEMA = [
    'id            INTEGER PRIMARY KEY AUTOINCREMENT',
    'feedID        TEXT               ',
    'primaryHash   TEXT               ',
    'secondaryHash TEXT               ',
    'providedID    TEXT               ',
    'entryURL      TEXT               ',
    'date          INTEGER            ',
    'read          INTEGER DEFAULT 0  ',
    'updated       INTEGER DEFAULT 0  ',
    'starred       INTEGER DEFAULT 0  ',
    'deleted       INTEGER DEFAULT 0  ',
    'bookmarkID    INTEGER DEFAULT -1 '
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


Components.utils.import('resource://brief/FeedContainer.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

XPCOMUtils.defineLazyServiceGetter(this, 'ObserverService', '@mozilla.org/observer-service;1', 'nsIObserverService');
XPCOMUtils.defineLazyServiceGetter(this, 'Bookmarks', '@mozilla.org/browser/nav-bookmarks-service;1', 'nsINavBookmarksService');

XPCOMUtils.defineLazyGetter(this, 'Prefs', function()
    Cc['@mozilla.org/preferences-service;1'].getService(Ci.nsIPrefService).
                                             getBranch('extensions.brief.').
                                             QueryInterface(Ci.nsIPrefBranch2)
);
XPCOMUtils.defineLazyGetter(this, 'Places', function() {
    var tempScope = {};
    Components.utils.import('resource://gre/modules/utils.js', tempScope);
    return tempScope.PlacesUtils;
});


var Connection = null;


// Exported object exposing public properties.
var Storage = {

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
     * @returns array of Feed's.
     */
    getAllFeeds: function(aIncludeFolders) {
        return StorageInternal.getAllFeeds(aIncludeFolders);
    },

    /**
     * Gets a list of distinct tags for URLs of entries stored in the database.
     *
     * @returns Array of tag names.
     */
    getAllTags: function() {
        return StorageInternal.getAllTags();
    },

    /**
     * Evaluates provided entries, inserting any new items and updating existing
     * items when newer versions are found. Also updates feed's properties.
     *
     * @param aFeed
     *        Contains the feed and the entries to evaluate.
     * @param aCallback
     *        Callback after the database is updated.
     */
    processFeed: function(aFeed, aCallback) {
        return StorageInternal.processFeed(aFeed, aCallback);
    },

    /**
     * Saves feed settings: entryAgeLimit, maxEntries, updateInterval and
     * markModifiedEntriesUnread.
     *
     * @param aFeed
     *        Feed object whose properties to use to update the respective
     *        columns in the database.
     */
    setFeedOptions: function(aFeed) {
        return StorageInternal.setFeedOptions(aFeed);
    },


    /**
     * Physically removes all deleted items and runs SQL VACUUM command to reclaim
     * disc space and defragment the database.
     */
    compactDatabase: function() {
        return StorageInternal.compactDatabase();
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
     * Registers an object to be notified of entry changes. A strong reference
     * is held to this object, so all observers have to be removed using
     * Storage.removeObserver().
     *
     * Observer must implement the following functions.
     *
     * Called when new entries are added to the database.
     *
     *     function onEntriesAdded(aEntryList)
     *
     * Called when properties of existing entries, such as title, content, authors
     * and date, are changed. When entries are updated, they can also be marked as unread.
     *
     *     function onEntriesUpdated(aEntryList);
     *
     * Called when the read/unread state of entries changes.
     *
     *     function onEntriesMarkedRead(aEntryList, aNewState);
     *
     * Called when URLs of entries are bookmarked/unbookmarked.
     *
     *     function onEntriesStarred(aEntryList, aNewState);
     *
     * Called when a tag is added or removed from entries.
     *
     *     function onEntriesTagged(aEntryList, aNewState, aTagName);
     *
     * Called when the deleted state of entries changes.
     *
     *     function onEntriesDeleted(aEntryList, aNewState);
     *
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

}


var StorageInternal = {

    feedsAndFoldersCache: null,
    feedsCache:           null,


    init: function StorageInternal_init() {
        var profileDir = Cc['@mozilla.org/file/directory_service;1'].
                         getService(Ci.nsIProperties).
                         get('ProfD', Ci.nsIFile);
        var databaseFile = profileDir.clone();
        databaseFile.append('brief.sqlite');
        var databaseIsNew = !databaseFile.exists();

        var storageService = Cc['@mozilla.org/storage/service;1'].
                             getService(Ci.mozIStorageService);
        Connection = storageService.openUnsharedDatabase(databaseFile);
        var schemaVersion = Connection.schemaVersion;

        // Remove the backup file after certain amount of time.
        var backupFile = profileDir.clone();
        backupFile.append('brief-backup-' + (schemaVersion - 1) + '.sqlite');
        if (backupFile.exists() && Date.now() - backupFile.lastModifiedTime > BACKUP_FILE_EXPIRATION_AGE)
            backupFile.remove(false);

        if (!Connection.connectionReady) {
            // The database was corrupted, back it up and create a new one.
            storageService.backupDatabaseFile(databaseFile, 'brief-backup.sqlite');
            Connection.close();
            databaseFile.remove(false);
            Connection = storageService.openUnsharedDatabase(databaseFile);
            this.setupDatabase();
        }
        else if (databaseIsNew) {
            this.setupDatabase();
        }
        else if (Connection.schemaVersion < DATABASE_VERSION) {
            // Remove the old backup file.
            if (backupFile.exists())
                backupFile.remove(false);

            // Backup the database before migration.
            var newBackupFile = profileDir;
            var filename = 'brief-backup-' + schemaVersion + '.sqlite';
            newBackupFile.append(filename);
            if (!newBackupFile.exists())
                storageService.backupDatabaseFile(databaseFile, filename);

            Migration.upgradeDatabase();
        }

        this.homeFolderID = Prefs.getIntPref('homeFolder');
        Prefs.addObserver('', this, false);
        ObserverService.addObserver(this, 'quit-application', false);

        // This has to be on the end, in case getting bookmarks service throws.
        Bookmarks.addObserver(BookmarkObserver, false);
    },

    setupDatabase: function Database_setupDatabase() {
        ExecuteSQL('CREATE TABLE IF NOT EXISTS feeds (' + FEEDS_TABLE_SCHEMA.join(',') + ')                   ');
        ExecuteSQL('CREATE TABLE IF NOT EXISTS entries (' + ENTRIES_TABLE_SCHEMA.join(',') + ')               ');
        ExecuteSQL('CREATE TABLE IF NOT EXISTS entry_tags (' + ENTRY_TAGS_TABLE_SCHEMA.join(',') + ')         ');
        ExecuteSQL('CREATE VIRTUAL TABLE entries_text USING fts3 (' + ENTRIES_TEXT_TABLE_SCHEMA.join(',') + ')');

        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_date_index ON entries (date)                ');
        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_feedID_date_index ON entries (feedID, date) ');

        // Speed up lookup when checking for updates.
        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_primaryHash_index ON entries (primaryHash) ');

        // Speed up SELECTs in the bookmarks observer.
        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_bookmarkID_index ON entries (bookmarkID) ');
        ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_entryURL_index ON entries (entryURL)     ');

        ExecuteSQL('CREATE INDEX IF NOT EXISTS entry_tagName_index ON entry_tags (tagName)');

        Connection.schemaVersion = DATABASE_VERSION;
    },


    // See Storage.
    getFeed: function StorageInternal_getFeed(aFeedID) {
        var foundFeed = null;
        var feeds = this.getAllFeeds(true);
        for (var i = 0; i < feeds.length; i++) {
            if (feeds[i].feedID == aFeedID) {
                foundFeed = feeds[i];
                break;
            }
        }
        return foundFeed;
    },

    // See Storage.
    getAllFeeds: function StorageInternal_getAllFeeds(aIncludeFolders) {
        if (!this.feedsCache) {
            this.feedsCache = [];
            this.feedsAndFoldersCache = [];

            var results = Stm.getAllFeeds.getResults(), row;

            while (row = results.next()) {
                let feed = new Feed();
                for (let column in row)
                    feed[column] = row[column];

                this.feedsAndFoldersCache.push(feed);
                if (!feed.isFolder)
                    this.feedsCache.push(feed);
            }
        }

        return aIncludeFolders ? this.feedsAndFoldersCache : this.feedsCache;
    },

    // See Storage.
    getAllTags: function StorageInternal_getAllTags() {
        return Stm.getAllTags.getAllResults().map(function(row) row.tagName);
    },


    // See Storage.
    processFeed: function StorageInternal_processFeed(aFeed, aCallback) {
        new FeedProcessor(aFeed, aCallback);
    },

    // See Storage.
    setFeedOptions: function StorageInternal_setFeedOptions(aFeed) {
        Stm.setFeedOptions.execute({
            'entryAgeLimit': aFeed.entryAgeLimit,
            'maxEntries': aFeed.maxEntries,
            'updateInterval': aFeed.updateInterval,
            'markUnread': aFeed.markModifiedEntriesUnread ? 1 : 0,
            'feedID': aFeed.feedID
        });

        // Update the cache if neccassary (it may not be if Feed instance that was
        // passed to us was itself taken from the cache).
        var feed = this.getFeed(aFeed.feedID);
        if (feed != aFeed) {
            feed.entryAgeLimit = aFeed.entryAgeLimit;
            feed.maxEntries = aFeed.maxEntries;
            feed.updateInterval = aFeed.updateInterval;
            feed.markModifiedEntriesUnread = aFeed.markModifiedEntriesUnread;
        }
    },


    // See Storage.
    compactDatabase: function StorageInternal_compactDatabase() {
        this.purgeEntries(false);
        ExecuteSQL('VACUUM');
    },


    // Moves expired entries to Trash and permanently removes
    // the deleted items from database.
    purgeEntries: function StorageInternal_purgeEntries(aDeleteExpired) {
        Connection.beginTransaction()
        try {
            if (aDeleteExpired) {
                // Delete old entries in feeds that don't have per-feed setting enabled.
                if (Prefs.getBoolPref('database.expireEntries')) {
                    let expirationAge = Prefs.getIntPref('database.entryExpirationAge');

                    Stm.expireEntriesByAgeGlobal.execute({
                        'oldState': Storage.ENTRY_STATE_NORMAL,
                        'newState': Storage.ENTRY_STATE_TRASHED,
                        'edgeDate': Date.now() - expirationAge * 86400000
                    });
                }

                // Delete old entries based on per-feed limit.
                this.getAllFeeds().forEach(function(feed) {
                    if (feed.entryAgeLimit > 0) {
                        Stm.expireEntriesByAgePerFeed.execute({
                            'oldState': Storage.ENTRY_STATE_NORMAL,
                            'newState': Storage.ENTRY_STATE_TRASHED,
                            'edgeDate': Date.now() - feed.entryAgeLimit * 86400000,
                            'feedID': feed.feedID
                        });
                    }
                })

                // Delete entries exceeding the maximum amount specified by maxStoredEntries pref.
                if (Prefs.getBoolPref('database.limitStoredEntries')) {
                    let maxEntries = Prefs.getIntPref('database.maxStoredEntries');

                    this.getAllFeeds().forEach(function(feed) {
                        let row = Stm.getDeletedEntriesCount.getSingleResult({
                            'feedID': feed.feedID,
                            'deletedState': Storage.ENTRY_STATE_NORMAL
                        })

                        if (row.entryCount - maxEntries > 0) {
                            Stm.expireEntriesByNumber.execute({
                                'oldState': Storage.ENTRY_STATE_NORMAL,
                                'newState': Storage.ENTRY_STATE_TRASHED,
                                'feedID': feed.feedID,
                                'limit': row.entryCount - maxEntries
                            });
                        }
                    })
                }
            }

            Stm.purgeDeletedEntriesText.execute({
                'deletedState': Storage.ENTRY_STATE_DELETED,
                'currentDate': Date.now(),
                'retentionTime': DELETED_FEEDS_RETENTION_TIME
            });

            Stm.purgeDeletedEntries.execute({
                'deletedState': Storage.ENTRY_STATE_DELETED,
                'currentDate': Date.now(),
                'retentionTime': DELETED_FEEDS_RETENTION_TIME
            });

            Stm.purgeDeletedFeeds.execute({
                'currentDate': Date.now(),
                'retentionTime': DELETED_FEEDS_RETENTION_TIME
            });
        }
        catch (ex) {
            ReportError(ex);
        }
        finally {
            Connection.commitTransaction();
        }

        // Prefs can only store longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        Prefs.setIntPref('database.lastPurgeTime', now);
    },

    // nsIObserver
    observe: function StorageInternal_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'quit-application':
                // Integer prefs are longs while Date is a long long.
                var now = Math.round(Date.now() / 1000);
                var lastPurgeTime = Prefs.getIntPref('database.lastPurgeTime');
                if (now - lastPurgeTime > PURGE_ENTRIES_INTERVAL)
                    this.purgeEntries(true);

                Bookmarks.removeObserver(BookmarkObserver);
                Prefs.removeObserver('', this);
                ObserverService.removeObserver(this, 'quit-application');

                BookmarkObserver.syncDelayTimer = null;
                break;

            case 'nsPref:changed':
                if (aData == 'homeFolder') {
                    this.homeFolderID = Prefs.getIntPref('homeFolder');
                    this.syncWithLivemarks();
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
        var index = this.observers.indexOf(aObserver);
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
        if (aState)
            Stm.starEntry.execute({ 'bookmarkID': aBookmarkID, 'entryID': aEntryID });
        else
            Stm.unstarEntry.execute({ 'id': aEntryID });

        if (aDontNotify)
            return;

        new Query(aEntryID).getEntryList(function(aList) {
            for each (let observer in StorageInternal.observers)
                observer.onEntriesStarred(aList, aState);
        });
    },

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
        Connection.beginTransaction();
        try {
            var params = { 'entryID': aEntryID, 'tagName': aTagName };

            if (aState) {
                let alreadyTagged = Stm.checkTag.getSingleResult(params).alreadyExists;
                if (alreadyTagged)
                    return;

                Stm.tagEntry.execute(params);
            }
            else {
                Stm.untagEntry.execute(params);
            }

            // Update the serialized list of tags stored in entries_text table.
            Stm.setSerializedTagList.execute({
                'tags': Utils.getTagsForEntry(aEntryID).join(', '),
                'entryID': aEntryID
            });

            new Query(aEntryID).getEntryList(function(aList) {
                for each (let observer in StorageInternal.observers)
                    observer.onEntriesTagged(aList, aState, aTagName);
            });
        }
        finally {
            Connection.commitTransaction();
        }
    },

    QueryInterface: XPCOMUtils.generateQI(Ci.nsIObserver)

}


/**
 * Evaluates provided entries, inserting any new items and updating existing
 * items when newer versions are found. Also updates feed's properties.
 */
function FeedProcessor(aFeed, aCallback) {
    this.feed = aFeed;
    this.callback = aCallback;

    var storedFeed = StorageInternal.getFeed(aFeed.feedID);
    this.oldestEntryDate = storedFeed.oldestEntryDate;

    var newDateModified = new Date(aFeed.wrappedFeed.updated).getTime();
    var prevDateModified = storedFeed.dateModified;

    if (aFeed.entries.length && (!newDateModified || newDateModified > prevDateModified)) {
        this.remainingEntriesCount = aFeed.entries.length;

        this.updatedEntries = [];
        this.insertedEntries = [];

        this.oldestEntryDate = Date.now();

        aFeed.entries.forEach(this.processEntry, this);
    }
    else {
        aCallback(0);
    }

    var properties = {
        'websiteURL': aFeed.websiteURL,
        'subtitle': aFeed.subtitle,
        'favicon': aFeed.favicon,
        'lastUpdated': Date.now(),
        'dateModified': newDateModified,
        'oldestEntryDate': this.oldestEntryDate,
        'feedID': aFeed.feedID
    }

    Stm.updateFeed.params = properties;
    Stm.updateFeed.executeAsync();

    // Keep cache up to date.
    var cachedFeed = StorageInternal.getFeed(aFeed.feedID);
    for (let p in properties)
        cachedFeed[p] = properties[p];
}

FeedProcessor.prototype = {

    entriesToUpdateCount: 0,
    entriesToInsertCount: 0,

    processEntry: function FeedProcessor_processEntry(aEntry) {
        if (aEntry.date && aEntry.date < this.oldestEntryDate)
            this.oldestEntryDate = aEntry.date;

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
        var providedID = aEntry.wrappedEntry.id;
        var primarySet = providedID ? [this.feed.feedID, providedID]
                                    : [this.feed.feedID, aEntry.entryURL];
        var secondarySet = [this.feed.feedID, aEntry.entryURL];

        // Special case for MediaWiki feeds: include the date in the hash. In
        // "Recent changes" feeds, entries for subsequent edits of a page differ
        // only in date (not in URL or GUID).
        var generator = this.feed.wrappedFeed.generator;
        if (generator && generator.agent.match('MediaWiki')) {
            primarySet.push(aEntry.date);
            secondarySet.push(aEntry.date);
        }

        var primaryHash = Utils.hashString(primarySet.join(''));
        var secondaryHash = Utils.hashString(secondarySet.join(''));

        // Look up if the entry is already present in the database.
        if (providedID) {
            var select = Stm.getEntryByPrimaryHash;
            select.params.primaryHash = primaryHash;
        }
        else {
            select = Stm.getEntryBySecondaryHash;
            select.params.secondaryHash = secondaryHash;
        }

        var storedID, storedDate, isEntryRead;
        var self = this;

        select.executeAsync({
            handleResult: function(aResults) {
                var row = aResults.next()
                storedID = row.id;
                storedDate = row.date;
                isEntryRead = row.read;
            },

            handleCompletion: function(aReason) {
                if (aReason == REASON_FINISHED) {
                    if (storedID) {
                        if (aEntry.date && storedDate < aEntry.date) {
                            self.addUpdateParams(aEntry, storedID, isEntryRead);
                        }
                    }
                    else {
                        self.addInsertParams(aEntry, primaryHash, secondaryHash);
                    }
                }

                self.remainingEntriesCount--;
                if (!self.remainingEntriesCount)
                    self.exacuteAndNotify();
            }
        });
    },

    addUpdateParams: function FeedProcessor_addUpdateParams(aEntry, aStoredEntryID, aIsRead) {
        var title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags
        var markUnread = StorageInternal.getFeed(this.feed.feedID).markModifiedEntriesUnread;

        Stm.updateEntry.paramSets.push({
            'date': aEntry.date,
            'read': markUnread || !aIsRead ? 0 : 1,
            'id': aStoredEntryID
        });

        Stm.updateEntryText.paramSets.push({
            'title': title,
            'content': aEntry.content || aEntry.summary,
            'authors': aEntry.authors,
            'id': aStoredEntryID
        });

        this.entriesToUpdateCount++;
        this.updatedEntries.push(aStoredEntryID);
    },

    addInsertParams: function FeedProcessor_addInsertParams(aEntry, aPrimaryHash, aSecondaryHash) {
        var title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags

        Stm.insertEntry.paramSets.push({
            'feedID': this.feed.feedID,
            'primaryHash': aPrimaryHash,
            'secondaryHash': aSecondaryHash,
            'providedID': aEntry.wrappedEntry.id,
            'entryURL': aEntry.entryURL,
            'date': aEntry.date || Date.now()
        });

        Stm.insertEntryText.paramSets.push({
            'title': title,
            'content': aEntry.content || aEntry.summary,
            'authors': aEntry.authors
        });

        this.entriesToInsertCount++;
    },

    exacuteAndNotify: function FeedProcessor_exacuteAndNotify() {
        var self = this;

        if (this.entriesToInsertCount) {
            Stm.getLastRowids.params.count = this.entriesToInsertCount;
            let statements = [Stm.insertEntry, Stm.insertEntryText, Stm.getLastRowids];

            ExecuteStatementsAsync(statements, {

                handleResult: function(aResults) {
                    var row;
                    while (row = aResults.getNextRow())
                        self.insertedEntries.push(row.getResultByName('id'));
                },

                handleCompletion: function(aReason) {
                    new Query(self.insertedEntries).getEntryList(function(aList) {
                        for each (let observer in StorageInternal.observers)
                            observer.onEntriesAdded(aList);
                    });

                    // XXX This should be optimized and/or be asynchronous
                    // query.verifyBookmarksAndTags();
                }
            });
        }

        if (this.entriesToUpdateCount) {
            let statements = [Stm.updateEntry, Stm.updateEntryText];

            ExecuteStatementsAsync(statements, function() {
                new Query(self.updatedEntries).getEntryList(function(aList) {
                    for each (let observer in StorageInternal.observers)
                        observer.onEntriesUpdated(aList);
                });
            });
        }

        this.callback(this.entriesToInsertCount);
    }
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
    else if (aConstraints.splice) {
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
     * Indicates if there are any entries that match this query.
     */
    hasMatches: function Query_hasMatches() {
        var sql = 'SELECT EXISTS (SELECT entries.id ' + this._getQueryString(true) + ') AS found';
        return new Statement(sql).getSingleResult(null, this._onDatabaseError).found;
    },

    /**
     * Get a simple list of entries.
     *
     * @returns Array if IDs.
     */
    getEntries: function Query_getEntries() {
        var sql = 'SELECT entries.id ' + this._getQueryString(true);

        try {
            var entries = [];
            var statement = Connection.createStatement(sql);
            while (statement.step())
                entries.push(statement.row.id);
        }
        catch(ex) {
            this._onDatabaseError(ex);
        }
        finally {
            statement.reset();
        }

        return entries;
    },


    /**
     * Get entries with all their properties.
     *
     * @returns Array of Entry objects.
     */
    getFullEntries: function Query_getFullEntries() {
        var sql = 'SELECT entries.id, entries.feedID, entries.entryURL, entries.date,   '+
                  '       entries.read, entries.starred, entries.updated,               '+
                  '       entries.bookmarkID, entries_text.title, entries_text.content, '+
                  '       entries_text.authors, entries_text.tags                       ';
        sql += this._getQueryString(true, true);

        var results = new Statement(sql).getResults(null, this._onDatabaseError);

        var entries = [], row;
        while (row = results.next()) {
            let entry = new Entry();

            for (let column in row)
                entry[column] = row[column]

            entries.push(entry);
        }

        return entries;
    },


    /**
     * Get values of a single property of each of the entries.
     *
     * @param aPropertyName
     *        Name of the property.
     * @param aDistinct
     *        Don't include multiple entries with the same value.
     * @returns Array of objects containing name-value pairs of the requested property
     *          and ID of the corresponding entry.
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

        var sql = 'SELECT entries.id, ' + table + aPropertyName +
                   this._getQueryString(true, getEntriesText);

        var objects = [], values = [], row;

        var results = new Statement(sql).getResults(null, this._onDatabaseError);

        while (row = results.next()) {
            let value = row[aPropertyName];
            if (aDistinct && values.indexOf(value) != -1)
                continue;

            values.push(value);

            let obj = {};
            obj[aPropertyName] = value;
            obj.ID = row.id;
            objects.push(obj);
        }

        return objects;
    },


    /**
     * Get the number of selected entries.
     */
    getEntryCount: function Query_getEntryCount() {
        // Optimization: don't sort.
        var tempOrder = this.sortOrder;
        this.sortOrder = undefined;
        var sql = 'SELECT COUNT(1) AS count ' + this._getQueryString(true);
        this.sortOrder = tempOrder;

        return new Statement(sql).getSingleResult(null, this._onDatabaseError).count;
    },


    /**
     * Get an EntryList of entries.
     */
    getEntryList: function Query_getEntryList(aCallback) {
        var entryIDs = [];
        var feedIDs = [];
        var tags = [];

        var tempHidden = this.includeHiddenFeeds;
        this.includeHiddenFeeds = false;
        var sql = 'SELECT entries.id, entries.feedID, entries_text.tags '
                   + this._getQueryString(true, true);
        this.includeHiddenFeeds = tempHidden;

        new Statement(sql).executeAsync({
            handleResult: function(aResults) {
                var row;
                while (row = aResults.next()) {
                    entryIDs.push(row.id);

                    if (feedIDs.indexOf(row.feedID) == -1)
                        feedIDs.push(row.feedID);

                    if (row.tags) {
                        tagArray = row.tags.split(', ');
                        for (let i = 0; i < tagArray.length; i++) {
                            if (tags.indexOf(tagArray[i]) === -1)
                                tags.push(tagArray[i]);
                        }
                    }
                }
            },

            handleCompletion: function(aReason) {
                var list = new EntryList();
                list.IDs = entryIDs;
                list.feedIDs = feedIDs;
                list.tags = tags;

                aCallback(list);
            }
        });
    },


    /**
     * Mark entries as read/unread.
     *
     * @param aState
     *        New state of entries (TRUE for read, FALSE for unread).
     */
    markEntriesRead: function Query_markEntriesRead(aState) {
        // Try not to include entries which already have the desired state,
        // but we can't omit them if a specific range of the selected entries
        // is meant to be marked.
        var tempRead = this.read;
        if (!this.limit && !this.offset)
            this.read = !aState;

        var sql = 'UPDATE entries SET read = :read, updated = 0 ' + this._getQueryString();
        var update = new Statement(sql);
        update.params.read = aState ? 1 : 0;

        this.getEntryList(function(aList) {
            this.read = tempRead;

            update.executeAsync(function() {
                if (aList.length) {
                    for each (let observer in StorageInternal.observers)
                        observer.onEntriesMarkedRead(aList, aState);
                }
            });
        });
    },

    /**
     * Set the deleted state of the selected entries or remove them from the database.
     *
     * @param aState
     *        The new deleted state (as defined by constants in Storage)
     *        or instruction to physically remove the entries from the
     *        database (REMOVE_FROM_DATABASE constant below).
     *
     * @throws NS_ERROR_INVALID_ARG on invalid |aState| parameter.
     */
    REMOVE_FROM_DATABASE: 4,

    deleteEntries: function Query_deleteEntries(aState) {
        switch (aState) {
            case Storage.ENTRY_STATE_NORMAL:
            case Storage.ENTRY_STATE_TRASHED:
            case Storage.ENTRY_STATE_DELETED:
                var sql = 'UPDATE entries SET deleted = ' + aState + this._getQueryString();
                break;
            case this.REMOVE_FROM_DATABASE:
                var sql = 'DELETE FROM entries ' + this._getQueryString();
                break;
            default:
                throw Components.results.NS_ERROR_INVALID_ARG;
        }

        this.getEntryList(function(aList) {
            new Statement(sql).executeAsync(function() {
                if (aList.length) {
                    for each (let observer in StorageInternal.observers)
                        observer.onEntriesDeleted(aList, aState);
                }
            });
        });
    },


    /**
     * Bookmark/unbookmark URLs of the selected entries.
     *
     * @param state
     *        New state of entries. TRUE to bookmark, FALSE to unbookmark.
     *
     * This function bookmarks URIs of the selected entries. It doesn't star the entries
     * in the database or send notifications - that part is performed by the bookmark
     * observer.
     */
    bookmarkEntries: function Query_bookmarkEntries(aState) {
        var transSrv = Cc['@mozilla.org/browser/placesTransactionsService;1'].
                       getService(Ci.nsIPlacesTransactionsService);
        var transactions = []

        this.getFullEntries().forEach(function(entry) {
            let uri = Utils.newURI(entry.entryURL);
            if (!uri)
                return;

            if (aState) {
                let trans = transSrv.createItem(uri, Places.unfiledBookmarksFolderId,
                                                Bookmarks.DEFAULT_INDEX, entry.title);
                transactions.push(trans);
            }
            else {
                let bookmarks = Bookmarks.getBookmarkIdsForURI(uri, {})
                                         .filter(Utils.isNormalBookmark);
                if (bookmarks.length) {
                    for (let i = bookmarks.length - 1; i >= 0; i--) {
                        let trans = transSrv.removeItem(bookmarks[i]);
                        transactions.push(trans);
                    }
                }
                else {
                    // If there are no bookmarks for an URL that is starred in our
                    // database, it means that the database is out of sync and we
                    // must update the database directly.
                    StorageInternal.starEntry(false, entry.id, bookmarks[0]);
                }
            }
        })

        var aggregatedTrans = transSrv.aggregateTransactions('', transactions);
        transSrv.doTransaction(aggregatedTrans);
    },

    /**
     * Verifies entries' starred statuses and their tags.
     *
     * Normally, the starred status is automatically kept in sync with user's bookmarks,
     * but there's always a possibility that it goes out of sync, for example while
     * Brief is disabled or uninstalled. If an entry is starred but no bookmarks are
     * found for its URI, then a new bookmark is added. If an entry isn't starred,
     * but there is a bookmark for its URI, this function stars the entry.
     * Tags are verified in the same manner.
     *
     * @returns TRUE if the starred status was in sync, FALSE otherwise.
     */
    verifyBookmarksAndTags: function Query_verifyBookmarksAndTags() {
        var statusOK = true;

        this.getFullEntries().forEach(function(entry) {
            let uri = Utils.newURI(entry.entryURL);
            if (!uri)
                return;

            let allBookmarks = Bookmarks.getBookmarkIdsForURI(uri, {});

            // Verify bookmarks.
            let normalBookmarks = allBookmarks.filter(Utils.isNormalBookmark);
            if (entry.starred && !normalBookmarks.length) {
                new Query(entry.id).bookmarkEntries(true);
                statusOK = false;
            }
            else if (!entry.starred && normalBookmarks.length) {
                StorageInternal.starEntry(true, entry.id, normalBookmarks[0]);
                statusOK = false;
            }

            // Verify tags.
            var storedTags = Utils.getTagsForEntry(entry.id);

            var currentTags = allBookmarks.map(function(id) Bookmarks.getFolderIdForItem(id))
                                          .filter(Utils.isTagFolder)
                                          .map(function(id) Bookmarks.getItemTitle(id));

            storedTags.forEach(function(tag) {
                if (currentTags.indexOf(tag) === -1) {
                    Places.tagging.tagURI(uri, [tag]);
                    statusOK = false;
                }
            })

            currentTags.forEach(function(tag) {
                if (storedTags.indexOf(tag) === -1) {
                    StorageInternal.tagEntry(true, entry.id, tag);
                    statusOK = false;
                }
            })
        })

        return statusOK;
    },


    /**
     * Actual list of folders selected by the query, including subfolders
     * of folders specified by Query.folders.
     */
    _effectiveFolders: null,


    _onDatabaseError: function BriefQuery__onDatabaseError() {
        // Ignore "SQL logic error or missing database" error which full-text search
        // throws when the query doesn't contain at least one non-excluded term.
        if (Connection.lastError != 1)
            ReportError(ex, true);
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
        var text = aForSelect ? ' FROM entries '
                              : ' WHERE entries.id IN (SELECT entries.id FROM entries ';

        if (!this.feeds && !this.includeHiddenFeeds)
            text += ' INNER JOIN feeds ON entries.feedID = feeds.feedID ';

        if (aGetFullEntries || this.searchString || this.sortOrder == this.SORT_BY_TITLE)
            text += ' INNER JOIN entries_text ON entries.id = entries_text.rowid ';

        if (this.tags)
            text += ' INNER JOIN entry_tags ON entries.id = entry_tags.entryID ';

        var constraints = [];

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
            constraints.push('entries.read = 0');

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

            var sortDir = (this.sortDirection == this.SORT_ASCENDING) ? 'ASC' : 'DESC';
            text += 'ORDER BY ' + sortOrder + sortDir;

            // Sort by rowid, so that entries that are equal in respect of primary
            // sorting criteria are always returned in the same (as opposed to
            // undefined) order.
            text += ', entries.rowid ' + sortDir;
        }

        if (this.limit !== undefined)
            text += ' LIMIT ' + this.limit;
        if (this.offset > 0)
            text += ' OFFSET ' + this.offset;

        if (!aForSelect)
            text += ') ';

        return text;
    },

    _traverseFolderChildren: function Query__traverseFolderChildren(aFolder) {
        var isEffectiveFolder = (this._effectiveFolders.indexOf(aFolder) != -1);
        var items = StorageInternal.getAllFeeds(true);

        for (let i = 0; i < items.length; i++) {
            if (items[i].parent == aFolder && items[i].isFolder) {
                if (isEffectiveFolder)
                    this._effectiveFolders.push(items[i].feedID);
                this._traverseFolderChildren(items[i].feedID);
            }
        }
    }

}


function ExecuteSQL(aSQLString) {
    try {
        Connection.executeSimpleSQL(aSQLString);
    }
    catch (ex) {
        log('SQL statement: ' + aSQLString);
        ReportError(ex, true);
    }
}

function Statement(aSQLString, aDefaultParams) {
    try {
        this._wrappedStatement = Connection.createStatement(aSQLString);
    }
    catch (ex) {
        log('SQL statement:\n' + aSQLString);
        ReportError(ex, true);
    }

    this._defaultParams = aDefaultParams;
    this.paramSets = [];
    this.params = {};
}

Statement.prototype = {

    execute: function Statement_execute(aParams) {
        if (aParams)
            this.params = aParams;

        this._bindParams();
        this._wrappedStatement.execute();
    },

    executeAsync: function Statement_executeAsync(aCallback) {
        this._bindParams();
        var callback = new StatementCallback(this._wrappedStatement, aCallback);
        this._wrappedStatement.executeAsync(callback);
    },

    _bindParams: function Statement__bindParams() {
        for (let column in this._defaultParams)
            this._wrappedStatement.params[column] = this._defaultParams[column];

        if (!this.paramSets.length) {
            for (let column in this.params)
                this._wrappedStatement.params[column] = this.params[column];
        }
        else {
            let bindingParamsArray = this._wrappedStatement.newBindingParamsArray();

            for (let i = 0; i < this.paramSets.length; i++) {
                let set = this.paramSets[i];
                let bp = bindingParamsArray.newBindingParams();
                for (let column in set)
                    bp.bindByName(column, set[column])
                bindingParamsArray.addParams(bp);
            }

            this._wrappedStatement.bindParameters(bindingParamsArray);
        }

        this.paramSets = [];
        this.params = {};
    },

    getResults: function Statement_getResults(aParams, aOnError) {
        if (aParams)
            this.params = aParams;

        this._bindParams();

        var columns = [];
        var columnCount = this._wrappedStatement.columnCount;
        for (let i = 0; i < columnCount; i++)
            columns.push(this._wrappedStatement.getColumnName(i));

        try {
            while (true) {
                let row = null;
                if (this._wrappedStatement.step()) {
                    row = {};
                    for (let i = 0; i < columnCount; i++)
                        row[columns[i]] = this._wrappedStatement.row[columns[i]];
                }

                yield row;
            }
        }
        catch (ex) {
            if (aOnError)
                aOnError();
            else
                throw(ex);
        }
        finally {
            this._wrappedStatement.reset();
        }
    },

    getSingleResult: function Statement_getSingleResult(aParams, aOnError) {
        var results = this.getResults(aParams, aOnError);
        var row = results.next();
        results.close();

        return row;
    },

    getAllResults: function Statement_getAllResults(aParams, aOnError) {
        var results = this.getResults(aParams, aOnError);
        var row, rows = [];
        while (row = results.next())
            rows.push(row);

        return rows;
    },

    reset: function Statement_reset() {
        this.paramSets = [];
        this.params = {};
        this._wrappedStatement.reset();
    }

}

function StatementCallback(aStatement, aCallback) {
    this._statement = aStatement;

    if (typeof aCallback == 'function') {
        this._callback =  {
            handleCompletion: aCallback
        }
    }
    else {
        this._callback = aCallback || {};
    }
}

StatementCallback.prototype = {

    handleResult: function(aResultSet) {
        if (!this._callback.handleResult)
            return;

        if (this._statement) {
            let gen = this._getResultsGenerator(aResultSet);
            this._callback.handleResult(gen);
            gen.close();
        }
        else {
            // When using ExecuteStatementsAsync the callback doesn't know
            // which statement is being handled so we can't use a generator.
            this._callback.handleResult(aResultSet);
        }
    },

    handleCompletion: function(aReason) {
        if (this._callback.handleCompletion)
            this._callback.handleCompletion(aReason);
    },

    handleError: function(aError) {
        if (this._callback.handleError)
            this._callback.handleError(aError);
        else
            ReportError(aError.message);
    },

    _getResultsGenerator: function Statement__getResultsGenerator(aResultSet) {
        var columnCount = this._statement.columnCount;

        while (true) {
            let obj = null;

            let row = aResultSet.getNextRow();
            if (row) {
                obj = {};
                for (let i = 0; i < columnCount; i++) {
                    let column = this._statement.getColumnName(i);
                    obj[column] = row.getResultByName(column);
                }
            }

            yield obj;
        }
    }
}

function ExecuteStatementsAsync(aStatements, aCallback) {
    var nativeStatements = [];

    for (let i = 0; i < aStatements.length; i++) {
        aStatements[i]._bindParams();
        nativeStatements.push(aStatements[i]._wrappedStatement);
    }

    Connection.executeAsync(nativeStatements, nativeStatements.length,
                            new StatementCallback(null, aCallback));
}


var BookmarkObserver = {

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
    onItemAdded: function BookmarkObserver_onItemAdded(aItemID, aFolder, aIndex, aItemType) {
        if (aItemType == Bookmarks.TYPE_FOLDER && Utils.isInHomeFolder(aFolder)) {
            this.delayedLivemarksSync();
            return;
        }

        // Only care about plain bookmarks and tags.
        if (Utils.isLivemark(aFolder) || aItemType != Bookmarks.TYPE_BOOKMARK)
            return;

        // Find entries with the same URI as the added item and tag or star them.
        var url = Bookmarks.getBookmarkURI(aItemID).spec;
        var isTag = Utils.isTagFolder(aFolder);

        Utils.getEntriesByURL(url, function(aEntries) {
            aEntries.forEach(function(entry) {
                if (isTag) {
                    let tagName = Bookmarks.getItemTitle(aFolder);
                    StorageInternal.tagEntry(true, entry, tagName, aItemID);
                }
                else {
                    StorageInternal.starEntry(true, entry, aItemID);
                }
            })
        })
    },


    // nsINavBookmarkObserver
    onBeforeItemRemoved: function BookmarkObserver_onBeforeItemRemoved(aItemID, aItemType) {},

    // nsINavBookmarkObserver
    onItemRemoved: function BookmarkObserver_onItemRemoved(aItemID, aFolder, aIndex, aItemType) {
        if (Utils.isLivemarkStored(aItemID) || aItemID == StorageInternal.homeFolderID) {
            this.delayedLivemarksSync();
            return;
        }

        // Only care about plain bookmarks and tags.
        if (Utils.isLivemark(aFolder) || aItemType != Bookmarks.TYPE_BOOKMARK)
            return;

        var isTag = Utils.isTagFolder(aFolder);

        if (isTag) {
            let tagName = Bookmarks.getItemTitle(aFolder);

            Utils.getEntriesByTagName(tagName, function(aEntries) {
                aEntries.forEach(function(entry) {
                    StorageInternal.tagEntry(false, entry, tagName);
                })
            })
        }
        else {
            Utils.getEntriesByBookmarkID(aItemID, function(aEntries) {

                // Look for other bookmarks for this URI. If there is another
                // bookmark for this URI, don't unstar the entry, but update
                // its bookmarkID to point to that bookmark.
                if (aEntries.length) {
                    let uri = Utils.newURI(aEntries[0].url);
                    var bookmarks = Bookmarks.getBookmarkIdsForURI(uri, {}).
                                              filter(Utils.isNormalBookmark);
                }

                aEntries.forEach(function(entry) {
                    if (bookmarks.length)
                        StorageInternal.starEntry(true, entry.id, bookmarks[0], true);
                    else
                        StorageInternal.starEntry(false, entry.id);
                })
            })
        }
    },

    // nsINavBookmarkObserver
    onItemMoved: function BookmarkObserver_onItemMoved(aItemID, aOldParent, aOldIndex,
                                                   aNewParent, aNewIndex, aItemType) {
        var wasInHome = Utils.isLivemarkStored(aItemID);
        var isInHome = aItemType == Bookmarks.TYPE_FOLDER && Utils.isInHomeFolder(aNewParent);
        if (wasInHome || isInHome)
            this.delayedLivemarksSync();
    },

    // nsINavBookmarkObserver
    onItemChanged: function BookmarkObserver_onItemChanged(aItemID, aProperty,
                                                           aIsAnnotationProperty, aNewValue,
                                                           aLastModified, aItemType) {
        switch (aProperty) {
        case 'title':
            let feed = Utils.getFeedByBookmarkID(aItemID);
            if (feed) {
                Stm.setFeedTitle.execute({ 'title': aNewValue, 'feedID': feed.feedID });
                feed.title = aNewValue; // Update the cache.

                ObserverService.notifyObservers(null, 'brief:feed-title-changed', feed.feedID);
            }
            else if (Utils.isTagFolder(aItemID)) {
                this.renameTag(aItemID, aNewValue);
            }
            break;

        case 'livemark/feedURI':
            if (Utils.isLivemarkStored(aItemID))
                this.delayedLivemarksSync();
            break;

        case 'uri':
            // Unstar any entries with the old URI.
            Utils.getEntriesByBookmarkID(aItemID, function(aEntries) {
                aEntries.forEach(function(entry) {
                    StorageInternal.starEntry(false, entry.id);
                })
            })

            // Star any entries with the new URI.
            Utils.getEntriesByURL(aNewValue, function(aEntries) {
                aEntries.forEach(function(entry) {
                    StorageInternal.starEntry(true, entry, aItemID);
                })
            })

            break;
        }
    },

    // nsINavBookmarkObserver
    onItemVisited: function BookmarkObserver_aOnItemVisited(aItemID, aVisitID, aTime) { },

    get syncDelayTimer BookmarkObserver_syncDelayTimer() {
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
        // Get bookmarks in the renamed tag folder.
        var options = Places.history.getNewQueryOptions();
        var query = Places.history.getNewQuery();
        query.setFolders([aTagFolderID], 1);
        var result = Places.history.executeQuery(query, options);
        result.root.containerOpen = true;

        for (let i = 0; i < result.root.childCount; i++) {
            let tagID = result.root.getChild(i).itemId;
            let uri = Bookmarks.getBookmarkURI(tagID);

            Utils.getEntriesByURL(uri.spec, function(aEntries) {
                aEntries.forEach(function(entryID) {

                    StorageInternal.tagEntry(true, entryID, aNewName);

                    let storedTags = Utils.getTagsForEntry(entryID);
                    let currentTags = Bookmarks.getBookmarkIdsForURI(uri, {})
                                               .map(function(id) Bookmarks.getFolderIdForItem(id))
                                               .filter(Utils.isTagFolder)
                                               .map(function(id) Bookmarks.getItemTitle(id));

                    storedTags.forEach(function(tag) {
                        if (currentTags.indexOf(tag) === -1)
                            StorageInternal.tagEntry(false, entryID, tag);
                    })
                })
            })
        }

        result.root.containerOpen = false;
    },

    observe: function BookmarkObserver_observe(aSubject, aTopic, aData) {
        if (aTopic == 'timer-callback') {
            this.livemarksSyncPending = false;
            StorageInternal.syncWithLivemarks();
        }
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsINavBookmarkObserver, Ci.nsIObserver])

}


/**
 * Synchronizes the list of feeds stored in the database with
 * the livemarks available in the Brief's home folder.
 */
function LivemarksSync() {
    if (!this.checkHomeFolder())
        return;

    this.newLivemarks = [];

    Connection.beginTransaction();
    try {
        // Get the list of livemarks and folders in the home folder.
        this.getLivemarks();

        // Get the list of feeds stored in the database.
        this.getStoredFeeds();

        this.foundLivemarks.forEach(function(livemark) {
            let feed = null;
            for (let i = 0; i < this.storedFeeds.length; i++) {
                if (this.storedFeeds[i].feedID == livemark.feedID) {
                    feed = this.storedFeeds[i];
                    break;
                }
            }

            if (feed) {
                feed.bookmarked = true;
                this.updateFeedFromLivemark(livemark, feed);
            }
            else {
                this.insertFeed(livemark);
                if (!livemark.isFolder)
                    this.newLivemarks.push(livemark);
            }
        }, this)

        this.storedFeeds.forEach(function(feed) {
            if (!feed.bookmarked && feed.hidden == 0)
                this.hideFeed(feed);
        }, this)
    }
    finally {
        Connection.commitTransaction();
    }

    if (this.feedListChanged) {
        StorageInternal.feedsCache = StorageInternal.feedsAndFoldersCache = null;
        ObserverService.notifyObservers(null, 'brief:invalidate-feedlist', '');
    }

    // Update the newly added feeds.
    if (this.newLivemarks.length) {
        var feeds = [];
        for each (let livemark in this.newLivemarks)
            feeds.push(StorageInternal.getFeed(livemark.feedID));

        FeedUpdateService.updateFeeds(feeds);
    }
}

LivemarksSync.prototype = {

    storedFeeds: null,
    newLivemarks: null,
    foundLivemarks: null,
    feedListChanged: false,

    checkHomeFolder: function BookmarksSync_checkHomeFolder() {
        var folderValid = true;
        var homeFolder = Prefs.getIntPref('homeFolder');

        if (homeFolder == -1) {
            let hideAllFeeds = new Statement('UPDATE feeds SET hidden = :hidden');
            hideAllFeeds.execute({ 'hidden': Date.now() });

            StorageInternal.feedsCache = StorageInternal.feedsAndFoldersCache = null;
            ObserverService.notifyObservers(null, 'brief:invalidate-feedlist', '');
            folderValid = false;
        }
        else {
            try {
                // This will throw if the home folder was deleted.
                Bookmarks.getItemTitle(homeFolder);
            }
            catch (e) {
                Prefs.clearUserPref('homeFolder');
                folderValid = false;
            }
        }

        return folderValid;
    },


    // Get the list of Live Bookmarks in the user's home folder.
    getLivemarks: function BookmarksSync_getLivemarks() {
        var homeFolder = Prefs.getIntPref('homeFolder');
        this.foundLivemarks = [];

        var options = Places.history.getNewQueryOptions();
        var query = Places.history.getNewQuery();
        query.setFolders([homeFolder], 1);
        options.excludeItems = true;

        var result = Places.history.executeQuery(query, options);
        this.traversePlacesQueryResults(result.root);
    },


    // Gets all feeds stored in the database.
    getStoredFeeds: function BookmarksSync_getStoredFeeds() {
        var sql = 'SELECT feedID, title, rowIndex, isFolder, parent, bookmarkID, hidden FROM feeds';
        this.storedFeeds = new Statement(sql).getAllResults();
    },


    insertFeed: function BookmarksSync_insertFeed(aBookmark) {
        var sql = 'INSERT OR IGNORE INTO feeds                                                   ' +
                  '(feedID, feedURL, title, rowIndex, isFolder, parent, bookmarkID)              ' +
                  'VALUES (:feedID, :feedURL, :title, :rowIndex, :isFolder, :parent, :bookmarkID)';

        new Statement(sql).execute({
            'feedID': aBookmark.feedID,
            'feedURL': aBookmark.feedURL || null,
            'title': aBookmark.title,
            'rowIndex': aBookmark.rowIndex,
            'isFolder': aBookmark.isFolder ? 1 : 0,
            'parent': aBookmark.parent,
            'bookmarkID': aBookmark.bookmarkID
        });

        this.feedListChanged = true;
    },


    updateFeedFromLivemark: function BookmarksSync_updateFeedFromLivemark(aItem, aFeed) {
        var properties = ['rowIndex', 'parent', 'title', 'bookmarkID'];
        if (!aFeed.hidden && properties.every(function(p) aFeed[p] == aItem[p]))
            return;

        var sql = 'UPDATE feeds SET title = :title, rowIndex = :rowIndex, parent = :parent, ' +
                  '                 bookmarkID = :bookmarkID, hidden = 0                    ' +
                  'WHERE feedID = :feedID                                                   ';

        new Statement(sql).execute({
            'title': aItem.title,
            'rowIndex': aItem.rowIndex,
            'parent': aItem.parent,
            'bookmarkID': aItem.bookmarkID,
            'feedID': aItem.feedID
        });

        if (aItem.rowIndex != aFeed.rowIndex || aItem.parent != aFeed.parent || aFeed.hidden > 0) {
            this.feedListChanged = true;
        }
        else {
            // Invalidate feeds cache.
            StorageInternal.feedsCache = StorageInternal.feedsAndFoldersCache = null;
            ObserverService.notifyObservers(null, 'brief:feed-title-changed', aItem.feedID);
        }
    },


    hideFeed: function BookmarksSync_hideFeed(aFeed) {
        if (aFeed.isFolder) {
            let hideFolder = new Statement('DELETE FROM feeds WHERE feedID = :feedID');
            hideFolder.execute({ 'feedID': aFeed.feedID });
        }
        else {
            let hideFeed = new Statement('UPDATE feeds SET hidden = :hidden WHERE feedID = :feedID');
            hideFeed.execute({ 'hidden': Date.now(), 'feedID': aFeed.feedID });
        }

        this.feedListChanged = true;
    },


    traversePlacesQueryResults: function BookmarksSync_traversePlacesQueryResults(aContainer) {
        aContainer.containerOpen = true;

        for (var i = 0; i < aContainer.childCount; i++) {
            var node = aContainer.getChild(i);

            if (node.type != Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER)
                continue;

            var item = {};
            item.title = Bookmarks.getItemTitle(node.itemId);
            item.bookmarkID = node.itemId;
            item.rowIndex = this.foundLivemarks.length;
            item.parent = aContainer.itemId.toFixed().toString();

            if (Utils.isLivemark(node.itemId)) {
                var feedURL = Places.livemarks.getFeedURI(node.itemId).spec;
                item.feedURL = feedURL;
                item.feedID = Utils.hashString(feedURL);
                item.isFolder = false;

                this.foundLivemarks.push(item);
            }
            else {
                item.feedURL = '';
                item.feedID = node.itemId.toFixed().toString();
                item.isFolder = true;

                this.foundLivemarks.push(item);

                if (node instanceof Ci.nsINavHistoryContainerResultNode)
                    this.traversePlacesQueryResults(node);
            }
        }

        aContainer.containerOpen = false;
    }

}


// Cached statements.
var Stm = {

    get getAllFeeds() {
        var sql = 'SELECT feedID, feedURL, websiteURL, title, subtitle, dateModified, ' +
                  '       favicon, lastUpdated, oldestEntryDate, rowIndex, parent,    ' +
                  '       isFolder, bookmarkID, entryAgeLimit, maxEntries,            ' +
                  '       updateInterval, markModifiedEntriesUnread                   ' +
                  'FROM feeds                                                         ' +
                  'WHERE hidden = 0                                                   ' +
                  'ORDER BY rowIndex ASC                                              ';
        delete this.getAllFeeds;
        return this.getAllFeeds = new Statement(sql);
    },

    get getAllTags() {
        var sql = 'SELECT DISTINCT entry_tags.tagName                                    '+
                  'FROM entry_tags INNER JOIN entries ON entry_tags.entryID = entries.id '+
                  'WHERE entries.deleted = :deletedState                                 '+
                  'ORDER BY entry_tags.tagName                                           ';
        delete this.getAllTags;
        return this.getAllTags = new Statement(sql, { 'deletedState': Storage.ENTRY_STATE_NORMAL });
    },

    get updateFeed() {
        var sql = 'UPDATE feeds                                                  ' +
                  'SET websiteURL = :websiteURL, subtitle = :subtitle,           ' +
                  '    imageURL = :imageURL, imageLink = :imageLink,             ' +
                  '    imageTitle = :imageTitle, favicon = :favicon,             ' +
                  '    lastUpdated = :lastUpdated, dateModified = :dateModified, ' +
                  '    oldestEntryDate = :oldestEntryDate                        ' +
                  'WHERE feedID = :feedID                                        ';
        delete this.updateFeed;
        return this.updateFeed = new Statement(sql);
    },

    get setFeedTitle() {
        var sql = 'UPDATE feeds SET title = :title WHERE feedID = :feedID';
        delete this.setFeedTitle;
        return this.setFeedTitle = new Statement(sql);
    },

    get setFeedOptions() {
        var sql = 'UPDATE feeds                                ' +
                  'SET entryAgeLimit  = :entryAgeLimit,        ' +
                  '    maxEntries     = :maxEntries,           ' +
                  '    updateInterval = :updateInterval,       ' +
                  '    markModifiedEntriesUnread = :markUnread ' +
                  'WHERE feedID = :feedID                      ';
        delete this.setFeedOptions;
        return this.setFeedOptions = new Statement(sql);
    },

    get insertEntry() {
        var sql = 'INSERT INTO entries (feedID, primaryHash, secondaryHash, providedID, entryURL, date) ' +
                  'VALUES (:feedID, :primaryHash, :secondaryHash, :providedID, :entryURL, :date)        ';
        delete this.insertEntry;
        return this.insertEntry = new Statement(sql);
    },

    get insertEntryText() {
        var sql = 'INSERT INTO entries_text (title, content, authors) ' +
                  'VALUES(:title, :content, :authors)   ';
        delete this.insertEntryText;
        return this.insertEntryText = new Statement(sql);
    },

    get updateEntry() {
        var sql = 'UPDATE entries SET date = :date, read = :read, updated = 1 '+
                  'WHERE id = :id                                             ';
        delete this.updateEntry;
        return this.updateEntry = new Statement(sql);
    },

    get updateEntryText() {
        var sql = 'UPDATE entries_text SET title = :title, content = :content, '+
                  'authors = :authors WHERE rowid = :id                        ';
        delete this.updateEntryText;
        return this.updateEntryText = new Statement(sql);
    },

    get getLastRowids() {
        var sql = 'SELECT rowid FROM entries ORDER BY rowid DESC LIMIT :count';
        delete this.getLastRowids;
        return this.getLastRowids = new Statement(sql);
    },

    get purgeDeletedEntriesText() {
        var sql = 'DELETE FROM entries_text                                                 '+
                  'WHERE rowid IN (                                                         '+
                  '   SELECT entries.id                                                     '+
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID        '+
                  '   WHERE (entries.deleted = :deletedState AND feeds.oldestEntryDate > entries.date) '+
                  '         OR (:currentDate - feeds.hidden > :retentionTime AND feeds.hidden != 0)    '+
                  ')                                                                                   ';
        delete this.purgeDeletedEntriesText;
        return this.purgeDeletedEntriesText = new Statement(sql);
    },

    get purgeDeletedEntries() {
        var sql = 'DELETE FROM entries                                                      '+
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
        var sql = 'DELETE FROM feeds                                      '+
                  'WHERE :currentDate - feeds.hidden > :retentionTime AND '+
                  '      feeds.hidden != 0                                ';
        delete this.purgeDeletedFeeds;
        return this.purgeDeletedFeeds = new Statement(sql);
    },

    get expireEntriesByAgeGlobal() {
        var sql = 'UPDATE entries SET deleted = :newState                            ' +
                  'WHERE id IN (                                                     ' +
                  '   SELECT entries.id                                              ' +
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
                  '   WHERE entries.deleted = :oldState AND                          ' +
                  '         feeds.entryAgeLimit = 0 AND                              ' +
                  '         entries.starred = 0 AND                                  ' +
                  '         entries.date < :edgeDate                                 ' +
                  ')                                                                 ';
        delete expireEntriesByAgeGlobal;
        return expireEntriesByAgeGlobal = new Statement(sql);
    },

    get expireEntriesByAgePerFeed() {
        var sql = 'UPDATE entries SET deleted = :newState  ' +
                  'WHERE entries.deleted = :oldState AND   ' +
                  '      starred = 0 AND                   ' +
                  '      entries.date < :edgeDate AND      ' +
                  '      feedID = :feedID                  ';
        delete expireEntriesByAgePerFeed;
        return expireEntriesByAgePerFeed = new Statement(sql);
    },

    get expireEntriesByNumber() {
        var sql = 'UPDATE entries                    ' +
                  'SET deleted = :newState           ' +
                  'WHERE rowid IN (                  ' +
                  '    SELECT rowid                  ' +
                  '    FROM entries                  ' +
                  '    WHERE deleted = :oldState AND ' +
                  '          starred = 0 AND         ' +
                  '          feedID = :feedID        ' +
                  '    ORDER BY date ASC             ' +
                  '    LIMIT :limit                  ' +
                  ')                                 ';
        delete this.expireEntriesByNumber;
        return this.expireEntriesByNumber = new Statement(sql);
    },

    get getDeletedEntriesCount() {
        var sql = 'SELECT COUNT(1) AS entryCount FROM entries  ' +
                  'WHERE feedID = :feedID AND                  ' +
                  '      starred = 0 AND                       ' +
                  '      deleted = :deletedState               ';
        delete this.getDeletedEntriesCount;
        return this.getDeletedEntriesCount = new Statement(sql);
    },

    get getEntryByPrimaryHash() {
        var sql = 'SELECT id, date, read FROM entries WHERE primaryHash = :primaryHash';
        delete this.getEntryByPrimaryHash;
        return this.getEntryByPrimaryHash = new Statement(sql);
    },

    get getEntryBySecondaryHash() {
        var sql = 'SELECT id, date, read FROM entries WHERE secondaryHash = :secondaryHash';
        delete this.getEntryBySecondaryHash;
        return this.getEntryBySecondaryHash = new Statement(sql);
    },

    get selectEntriesByURL() {
        var sql = 'SELECT id FROM entries WHERE entryURL = :url';
        delete this.selectEntriesByURL;
        return this.selectEntriesByURL = new Statement(sql);
    },

    get selectEntriesByBookmarkID() {
        var sql = 'SELECT id, entryURL FROM entries WHERE bookmarkID = :bookmarkID';
        delete this.selectEntriesByBookmarkID;
        return this.selectEntriesByBookmarkID = new Statement(sql);
    },

    get selectEntriesByTagName() {
        var sql = 'SELECT id, entryURL FROM entries WHERE id IN (          '+
                  '    SELECT entryID FROM entry_tags WHERE tagName = :tagName '+
                  ')                                                       ';
        delete this.selectEntriesByTagName;
        return this.selectEntriesByTagName = new Statement(sql);
    },

    get starEntry() {
        var sql = 'UPDATE entries SET starred = 1, bookmarkID = :bookmarkID WHERE id = :entryID';
        delete this.starEntry;
        return this.starEntry = new Statement(sql);
    },

    get unstarEntry() {
        var sql = 'UPDATE entries SET starred = 0, bookmarkID = -1 WHERE id = :id';
        delete this.unstarEntry;
        return this.unstarEntry = new Statement(sql);
    },

    get checkTag() {
        var sql = 'SELECT EXISTS (                  '+
                  '    SELECT tagName               '+
                  '    FROM entry_tags              '+
                  '    WHERE tagName = :tagName AND '+
                  '          entryID = :entryID     '+
                  ') AS alreadyTagged               ';
        delete this.checkTag;
        return this.checkTag = new Statement(sql);
    },

    get tagEntry() {
        var sql = 'INSERT INTO entry_tags (entryID, tagName) '+
                  'VALUES (:entryID, :tagName)               ';
        delete this.tagEntry;
        return this.tagEntry = new Statement(sql);
    },

    get untagEntry() {
        var sql = 'DELETE FROM entry_tags WHERE entryID = :entryID AND tagName = :tagName';
        delete this.untagEntry;
        return this.untagEntry = new Statement(sql);
    },

    get getTagsForEntry() {
        var sql = 'SELECT tagName FROM entry_tags WHERE entryID = :entryID';
        delete this.getTagsForEntry;
        return this.getTagsForEntry = new Statement(sql);
    },

    get setSerializedTagList() {
        var sql = 'UPDATE entries_text SET tags = :tags WHERE rowid = :entryID';
        delete this.setSerializedTagList;
        return this.setSerializedTagList = new Statement(sql);
    }

}


var Migration = {

    upgradeDatabase: function Migration_upgradeDatabase() {
        switch (Connection.schemaVersion) {

        // Schema version checking has only been introduced in 0.8 beta 1. When migrating
        // from earlier releases we don't know the exact previous version, so we attempt
        // to apply all the changes since the beginning of time.
        case 0:
            try {
                // Columns added in 0.6.
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN oldestAvailableEntryDate INTEGER');
                ExecuteSQL('ALTER TABLE entries ADD COLUMN providedID TEXT');
            }
            catch (ex) { }

            try {
                // Columns and indices added in 0.7.
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN lastUpdated INTEGER');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN updateInterval INTEGER DEFAULT 0');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN entryAgeLimit INTEGER DEFAULT 0');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN maxEntries INTEGER DEFAULT 0');
                ExecuteSQL('ALTER TABLE entries ADD COLUMN authors TEXT');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN rowIndex INTEGER');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN parent TEXT');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN isFolder INTEGER');
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN RDF_URI TEXT');
            }
            catch (ex) { }
            // Fall through...

        // To 0.8.
        case 1:
            ExecuteSQL('ALTER TABLE entries ADD COLUMN secondaryID TEXT');
            ExecuteSQL('UPDATE entries SET content = summary, summary = "" WHERE content = ""');
            // Fall through...

        // To 1.0 beta 1
        case 2:
            try {
                ExecuteSQL('ALTER TABLE entries ADD COLUMN updated INTEGER DEFAULT 0');
            }
            catch (ex) { }
            // Fall through...

        // To 1.0
        case 3:
            ExecuteSQL('DROP INDEX IF EXISTS entries_id_index');
            ExecuteSQL('DROP INDEX IF EXISTS feeds_feedID_index');
            // Fall through...

        // To 1.2a1
        case 4:
            this.recomputeIDs();
            this.recreateFeedsTable();
            ExecuteSQL('ALTER TABLE entries ADD COLUMN bookmarkID INTEGER DEFAULT -1');
            // Fall through...

        // To 1.2b2
        case 5:
        case 6:
            if (Connection.schemaVersion > 4)
                ExecuteSQL('ALTER TABLE feeds ADD COLUMN markModifiedEntriesUnread INTEGER DEFAULT 1');
            // Fall through...

        // To 1.2b3
        case 7:
            this.migrateEntries();
            this.bookmarkStarredEntries();
            // Fall through...

        // To 1.2
        case 8:
            ExecuteSQL('DROP INDEX IF EXISTS entries_feedID_index');
            ExecuteSQL('CREATE INDEX IF NOT EXISTS entries_feedID_date_index ON entries (feedID, date) ');
            // Fall through...

        // To 1.5
        case 9:
            // Remove dead rows from entries_text.
            ExecuteSQL('DELETE FROM entries_text                       '+
                       'WHERE rowid IN (                               '+
                       '     SELECT entries_text.rowid                 '+
                       '     FROM entries_text LEFT JOIN entries       '+
                       '          ON entries_text.rowid = entries.id   '+
                       '     WHERE NOT EXISTS (                        '+
                       '         SELECT id                             '+
                       '         FROM entries                          '+
                       '         WHERE entries_text.rowid = entries.id '+
                       '     )                                         '+
                       ')                                              ');
        }

        Connection.schemaVersion = DATABASE_VERSION;
    },


    recreateFeedsTable: function Migration_recreateFeedsTable() {
        // Columns in this list must be in the same order as the respective columns
        // in the new schema.
        const OLD_COLS = 'feedID, feedURL, websiteURL, title, subtitle, imageURL,    '+
                         'imageLink, imageTitle, favicon, RDF_URI, rowIndex, parent, '+
                         'isFolder, hidden, lastUpdated, oldestAvailableEntryDate,   '+
                         'entryAgeLimit, maxEntries, updateInterval                  ';
        const NEW_COLS = 'feedID, feedURL, websiteURL, title, subtitle, imageURL,       '+
                         'imageLink, imageTitle, favicon, bookmarkID, rowIndex, parent, '+
                         'isFolder, hidden, lastUpdated, oldestEntryDate,               '+
                         'entryAgeLimit, maxEntries, updateInterval                     ';

        Connection.beginTransaction();
        try {
            ExecuteSQL('CREATE TABLE feeds_copy ('+OLD_COLS+')                               ');
            ExecuteSQL('INSERT INTO feeds_copy SELECT '+OLD_COLS+' FROM feeds                ');
            ExecuteSQL('DROP TABLE feeds                                                     ');
            ExecuteSQL('CREATE TABLE feeds (' + FEEDS_TABLE_SCHEMA.join(',') + ')            ');
            ExecuteSQL('INSERT INTO feeds ('+NEW_COLS+') SELECT '+OLD_COLS+' FROM feeds_copy ');
            ExecuteSQL('DROP TABLE feeds_copy                                                ');
        }
        catch (ex) {
            ReportError(ex, true);
        }
        finally {
            Connection.commitTransaction();
        }
    },


    migrateEntries: function Migration_migrateEntries() {
        Connection.beginTransaction();
        try {
            let cols = 'id, feedID, secondaryID, providedID, entryURL, date, authors, '+
                       'read, updated, starred, deleted, bookmarkID, title, content   ';

            ExecuteSQL('CREATE TABLE entries_copy ('+cols+')                  ');
            ExecuteSQL('INSERT INTO entries_copy SELECT '+cols+' FROM entries ');
            ExecuteSQL('DROP TABLE entries                                    ');

            StorageInternal.setupDatabase();

            let fromCols = 'feedID, providedID, entryURL, date, read, updated,       '+
                           'starred, deleted, bookmarkID, id, secondaryID            ';
            let toCols =   'feedID, providedID, entryURL, date, read, updated,       '+
                           'starred, deleted, bookmarkID, primaryHash, secondaryHash ';

            ExecuteSQL('INSERT INTO entries ('+toCols+')                                '+
                       'SELECT '+fromCols+' FROM entries_copy ORDER BY rowid            ');
            ExecuteSQL('INSERT INTO entries_text (title, content, authors)              '+
                       'SELECT title, content, authors FROM entries_copy ORDER BY rowid ');
            ExecuteSQL('DROP TABLE entries_copy                                         ');
        }
        catch (ex) {
            ReportError(ex, true);
        }
        finally {
            Connection.commitTransaction();
        }

        ExecuteSQL('VACUUM');
    },

    bookmarkStarredEntries: function Migration_bookmarkStarredEntries() {
        var sql = 'SELECT entries.entryURL, entries.id, entries_text.title                 '+
                  'FROM entries INNER JOIN entries_text ON entries.id = entries_text.rowid '+
                  'WHERE starred = 1                                                       ';
        var starredEntries = new Statement(sql).getResults();

        sql = 'UPDATE entries SET starred = 1, bookmarkID = :bookmarkID WHERE id = :entryID';
        var update = new Statement(sql);

        Connection.beginTransaction();
        try {
            var entry;
            while (entry = starredEntries.next()){
                let uri = Utils.newURI(entry.entryURL);
                if (!uri)
                    continue;

                let alreadyBookmarked = false;
                let bookmarkIDs = Bookmarks.getBookmarkIdsForURI(uri, {});
                for each (var bookmarkID in bookmarkIDs) {
                    if (Utils.isNormalBookmark(bookmarkID)) {
                        alreadyBookmarked = true;
                        break;
                    }
                }

                if (alreadyBookmarked) {
                    StorageInternal.starEntry(true, entry.id, bookmarkID);
                }
                else {
                    let bookmarkID = Bookmarks.insertBookmark(Bookmarks.unfiledBookmarksFolder,
                                                              uri, Bookmarks.DEFAULT_INDEX,
                                                              entry.title);
                    update.execute({
                        entryID: entry.id,
                        bookmarkID: bookmarkID
                    });
                }
            }
        }
        catch (ex) {
            ReportError(ex);
        }
        finally {
            starredEntries.close();
            Connection.commitTransaction();
        }
    },

    recomputeIDs: function Migration_recomputeIDs() {
        var hashStringFunc = {
            QueryInterface: XPCOMUtils.generateQI([Ci.mozIStorageFunction]),
            onFunctionCall: function(aArgs) Utils.hashString(aArgs.getUTF8String(0))
        }
        var generateEntryHashFunc = {
            QueryInterface: XPCOMUtils.generateQI([Ci.mozIStorageFunction]),
            onFunctionCall: function(aArgs) Utils.hashString(aArgs.getUTF8String(0) +
                                                             aArgs.getUTF8String(1))
        }

        Connection.createFunction('hashString', 1, hashStringFunc);
        Connection.createFunction('generateEntryHash', 2, generateEntryHashFunc);

        Connection.beginTransaction();
        try {
            ExecuteSQL('UPDATE OR IGNORE entries                                          ' +
                       'SET id = generateEntryHash(feedID, providedID)                    ' +
                       'WHERE rowid IN (                                                  ' +
                       '   SELECT entries.rowid                                           ' +
                       '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
                       '   WHERE entries.date >= feeds.oldestAvailableEntryDate AND       ' +
                       '         entries.providedID != ""                                 ' +
                       ')                                                                 ');
            ExecuteSQL('UPDATE OR IGNORE feeds SET feedID = hashString(feedURL) WHERE isFolder = 0');
        }
        catch (ex) {
            ReportError(ex, true);
        }
        finally {
            Connection.commitTransaction();
        }
    }

}


var Utils = {

    getTagsForEntry: function getTagsForEntry(aEntryID) {
        return Stm.getTagsForEntry.getAllResults({ 'entryID': aEntryID })
                                  .map(function(r) r.tagName);
    },

    getFeedByBookmarkID: function getFeedByBookmarkID(aBookmarkID) {
        var foundFeed = null;
        var feeds = StorageInternal.getAllFeeds(true);
        for (let i = 0; i < feeds.length; i++) {
            if (feeds[i].bookmarkID == aBookmarkID) {
                foundFeed = feeds[i];
                break;
            }
        }
        return foundFeed;
    },

    isLivemarkStored: function isLivemarkStored(aItemID) {
        return !!Utils.getFeedByBookmarkID(aItemID);
    },

    getEntriesByURL: function getEntriesByURL(aURL, aCallback) {
        var entries = [];

        Stm.selectEntriesByURL.params.url = aURL;
        Stm.selectEntriesByURL.executeAsync({
            handleResult: function(aResults) {
                var row;
                while (row = aResults.next())
                    entries.push(row.id);
            },

            handleCompletion: function(aReason) {
                aCallback(entries);
            }
        })
    },

    getEntriesByBookmarkID: function getEntriesByBookmarkID(aBookmarkID, aCallback) {
        var entries = [];

        Stm.selectEntriesByBookmarkID.params.bookmarkID = aBookmarkID;
        Stm.selectEntriesByBookmarkID.executeAsync({
            handleResult: function(aResults) {
                var row;
                while (row = aResults.next()) {
                    entries.push({
                        id: row.id,
                        url: row.entryURL
                    });
                }
            },

            handleCompletion: function(aReason) {
                aCallback(entries);
            }
        })
    },

    getEntriesByTagName: function getEntriesByTagName(aTagName, aCallback) {
        var entries = [];

        Stm.selectEntriesByTagName.params.tagName = aTagName;
        Stm.selectEntriesByTagName.executeAsync({
            handleResult: function(aResults) {
                var row;
                while (row = aResults.next())
                    entries.push(row.id)
            },

            handleCompletion: function(aReason) {
                aCallback(entries);
            }
        })
    },

    newURI: function(aSpec) {
        if (!this.ioService)
            this.ioService = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);

        try {
            var uri = this.ioService.newURI(aSpec, null, null);
        }
        catch (ex) {
            uri = null;
        }
        return uri;
    },

    isBookmark: function(aItemID) {
        return (Bookmarks.getItemType(aItemID) === Bookmarks.TYPE_BOOKMARK);
    },

    isNormalBookmark: function(aItemID) {
        let parent = Bookmarks.getFolderIdForItem(aItemID);
        return !Utils.isLivemark(parent) && !Utils.isTagFolder(parent);
    },

    isLivemark: function(aItemID) {
        return Places.livemarks.isLivemark(aItemID);
    },

    isFolder: function(aItemID) {
        return (Bookmarks.getItemType(aItemID) === Bookmarks.TYPE_FOLDER);
    },

    isTagFolder: function(aItemID) {
        return (Bookmarks.getFolderIdForItem(aItemID) === Places.tagsFolderId);
    },

    // Returns TRUE if an item is a subfolder of Brief's home folder.
    isInHomeFolder: function(aItemID) {
        var homeID = StorageInternal.homeFolderID;
        if (homeID === -1)
            return false;

        if (homeID === aItemID)
            return true;

        var inHome = false;
        var parent = aItemID;
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
        var unicodeConverter = Cc['@mozilla.org/intl/scriptableunicodeconverter'].
                               createInstance(Ci.nsIScriptableUnicodeConverter);
        unicodeConverter.charset = 'UTF-8';
        var stream = unicodeConverter.convertToInputStream(aString);

        var hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
        hasher.init(Ci.nsICryptoHash.MD5);
        hasher.updateFromStream(stream, stream.available());
        var hash = hasher.finish(false);

        // Convert the hash to a hex-encoded string.
        var hexchars = '0123456789ABCDEF';
        var hexrep = new Array(hash.length * 2);
        for (var i = 0; i < hash.length; ++i) {
            hexrep[i * 2] = hexchars.charAt((hash.charCodeAt(i) >> 4) & 15);
            hexrep[i * 2 + 1] = hexchars.charAt(hash.charCodeAt(i) & 15);
        }
        return hexrep.join('');
    }

}


function ReportError(aException, aRethrow) {
    var message = typeof aException == 'string' ? aException : aException.message;
    message += '\nStack: ' + aException.stack;
    message += '\nDatabase error: ' + Connection.lastErrorString;
    var error = new Error(message, aException.fileName, aException.lineNumber);
    if (aRethrow)
        throw(error);
    else
        Components.utils.reportError(error);
}


function log(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n' + aMessage);
}

StorageInternal.init();
