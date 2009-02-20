const Cc = Components.classes;
const Ci = Components.interfaces;

const PURGE_ENTRIES_INTERVAL = 3600*24; // 1 day
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // 1 week
const LIVEMARKS_SYNC_DELAY = 100;
const BACKUP_FILE_EXPIRATION_AGE = 3600*24*14; // 2 weeks
const DATABASE_VERSION = 9;

const FEEDS_TABLE_SCHEMA =
    'feedID          TEXT UNIQUE,         ' +
    'feedURL         TEXT,                ' +
    'websiteURL      TEXT,                ' +
    'title           TEXT,                ' +
    'subtitle        TEXT,                ' +
    'imageURL        TEXT,                ' +
    'imageLink       TEXT,                ' +
    'imageTitle      TEXT,                ' +
    'favicon         TEXT,                ' +
    'bookmarkID      TEXT,                ' +
    'rowIndex        INTEGER,             ' +
    'parent          TEXT,                ' +
    'isFolder        INTEGER,             ' +
    'hidden          INTEGER DEFAULT 0,   ' +
    'lastUpdated     INTEGER DEFAULT 0,   ' +
    'oldestEntryDate INTEGER,             ' +
    'entryAgeLimit   INTEGER DEFAULT 0,   ' +
    'maxEntries      INTEGER DEFAULT 0,   ' +
    'updateInterval  INTEGER DEFAULT 0,   ' +
    'dateModified    INTEGER DEFAULT 0,   ' +
    'markModifiedEntriesUnread INTEGER DEFAULT 1 ';

const ENTRIES_TABLE_SCHEMA =
    'id            INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'feedID        TEXT,               ' +
    'primaryHash   TEXT,               ' +
    'secondaryHash TEXT,               ' +
    'providedID    TEXT,               ' +
    'entryURL      TEXT,               ' +
    'date          INTEGER,            ' +
    'read          INTEGER DEFAULT 0,  ' +
    'updated       INTEGER DEFAULT 0,  ' +
    'starred       INTEGER DEFAULT 0,  ' +
    'deleted       INTEGER DEFAULT 0,  ' +
    'bookmarkID    INTEGER DEFAULT -1  ';

const ENTRIES_TEXT_TABLE_SCHEMA =
    'title   TEXT, ' +
    'content TEXT, ' +
    'authors TEXT, ' +
    'tags    TEXT  ';

const ENTRY_TAGS_TABLE_SCHEMA =
    'tagID    INTEGER, ' +
    'tagName  TEXT,    ' +
    'entryID  INTEGER  ';


Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');


__defineGetter__('gPlaces', function() {
    delete this.gPlaces;
    var tempScope = {};
    Components.utils.import('resource://gre/modules/utils.js', tempScope);
    return this.gPlaces = tempScope.PlacesUtils;
});

__defineGetter__('gObserverService', function() {
    delete this.gObserverService;
    return this.gObserverService = Cc['@mozilla.org/observer-service;1'].
                                   getService(Ci.nsIObserverService);
});

__defineGetter__('gPrefs', function() {
    delete this.gPrefs;
    return this.gPrefs = Cc['@mozilla.org/preferences-service;1'].
                         getService(Ci.nsIPrefService).
                         getBranch('extensions.brief.').
                         QueryInterface(Ci.nsIPrefBranch2);
});

__defineGetter__('gBms', function() {
    // XXX Getting bookmarks service at startup sometimes throws an exception.
    var bms = Cc['@mozilla.org/browser/nav-bookmarks-service;1'].
              getService(Ci.nsINavBookmarksService);
    delete this.gBms;
    return this.gBms = bms;
});



function executeSQL(aSQLString) {
    try {
        gConnection.executeSimpleSQL(aSQLString);
    }
    catch (ex) {
        log('SQL statement: ' + aSQLString);
        reportError(ex, true);
    }
}

function createStatement(aSQLString) {
    try {
        var statement = gConnection.createStatement(aSQLString);
    }
    catch (ex) {
        log('SQL statement: ' + aSQLString);
        reportError(ex, true);
    }
    var wrapper = Cc['@mozilla.org/storage/statement-wrapper;1'].
                  createInstance(Ci.mozIStorageStatementWrapper);
    wrapper.initialize(statement)
    return wrapper;
}


var gStorageService = null;
var gConnection = null;

function BriefStorageService() {
    this.observers = [];

    // The instantiation can't be done on app-startup, because the directory service
    // doesn't work yet, so we perform it on profile-after-change.
    gObserverService.addObserver(this, 'profile-after-change', false);
}

BriefStorageService.prototype = {

    feedsAndFoldersCache:  null,
    feedsCache:            null,

    instantiate: function BriefStorage_instantiate() {
        var profileDir = Cc['@mozilla.org/file/directory_service;1'].
                         getService(Ci.nsIProperties).
                         get('ProfD', Ci.nsIFile);
        var databaseFile = profileDir.clone();
        databaseFile.append('brief.sqlite');
        var databaseIsNew = !databaseFile.exists();

        var storageService = Cc['@mozilla.org/storage/service;1'].
                             getService(Ci.mozIStorageService);
        gConnection = storageService.openUnsharedDatabase(databaseFile);
        var schemaVersion = gConnection.schemaVersion;

        // Remove the backup file after certain amount of time.
        var backupFile = profileDir.clone();
        backupFile.append('brief-backup-' + (schemaVersion - 1) + '.sqlite');
        if (backupFile.exists() && Date.now() - backupFile.lastModifiedTime > BACKUP_FILE_EXPIRATION_AGE)
            backupFile.remove(false);

        if (!gConnection.connectionReady) {
            // The database was corrupted, back it up and create a new one.
            storageService.backupDatabaseFile(databaseFile, 'brief-backup.sqlite');
            gConnection.close();
            databaseFile.remove(false);
            gConnection = storageService.openUnsharedDatabase(databaseFile);
            this.setupDatabase();
            gConnection.schemaVersion = DATABASE_VERSION;
        }
        else if (databaseIsNew) {
            this.setupDatabase();
            gConnection.schemaVersion = DATABASE_VERSION;
        }
        else if (gConnection.schemaVersion < DATABASE_VERSION) {
            // Remove the old backup file.
            if (backupFile.exists())
                backupFile.remove(false);

            // Backup the database before migration.
            var newBackupFile = profileDir;
            var filename = 'brief-backup-' + schemaVersion + '.sqlite';
            newBackupFile.append(filename);
            if (!newBackupFile.exists())
                storageService.backupDatabaseFile(databaseFile, filename);

            this.migrateDatabase();
        }

        this.homeFolderID = gPrefs.getIntPref('homeFolder');
        gPrefs.addObserver('', this, false);
        gObserverService.addObserver(this, 'quit-application', false);

        // This has to be on the end, in case getting bookmarks service throws.
        gBms.addObserver(this, false);
    },

    setupDatabase: function BriefStorage_setupDatabase() {
        executeSQL('CREATE TABLE IF NOT EXISTS feeds ('+FEEDS_TABLE_SCHEMA+')                   ');
        executeSQL('CREATE TABLE IF NOT EXISTS entries ('+ENTRIES_TABLE_SCHEMA+')               ');
        executeSQL('CREATE TABLE IF NOT EXISTS entry_tags ('+ENTRY_TAGS_TABLE_SCHEMA+')         ');
        executeSQL('CREATE VIRTUAL TABLE entries_text USING fts3 ('+ENTRIES_TEXT_TABLE_SCHEMA+')');

        executeSQL('CREATE INDEX IF NOT EXISTS entries_date_index ON entries (date)                ');
        executeSQL('CREATE INDEX IF NOT EXISTS entries_feedID_date_index ON entries (feedID, date) ');

        // Speed up lookup when checking for updates.
        executeSQL('CREATE INDEX IF NOT EXISTS entries_primaryHash_index ON entries (primaryHash) ');

        // Speed up SELECTs in the bookmarks observer.
        executeSQL('CREATE INDEX IF NOT EXISTS entries_bookmarkID_index ON entries (bookmarkID) ');
        executeSQL('CREATE INDEX IF NOT EXISTS entries_entryURL_index ON entries (entryURL)     ');

        executeSQL('CREATE INDEX IF NOT EXISTS entry_tagName_index ON entry_tags (tagName)');
    },


    migrateDatabase: function BriefStorage_migrateDatabase() {
        switch (gConnection.schemaVersion) {

        // Schema version checking has only been introduced in 0.8 beta 1. When migrating
        // from earlier releases we don't know the exact previous version, so we attempt
        // to apply all the changes since the beginning of time.
        case 0:
            try {
                // Columns added in 0.6.
                executeSQL('ALTER TABLE feeds ADD COLUMN oldestAvailableEntryDate INTEGER');
                executeSQL('ALTER TABLE entries ADD COLUMN providedID TEXT');
            }
            catch (ex) { }

            try {
                // Columns and indices added in 0.7.
                executeSQL('ALTER TABLE feeds ADD COLUMN lastUpdated INTEGER');
                executeSQL('ALTER TABLE feeds ADD COLUMN updateInterval INTEGER DEFAULT 0');
                executeSQL('ALTER TABLE feeds ADD COLUMN entryAgeLimit INTEGER DEFAULT 0');
                executeSQL('ALTER TABLE feeds ADD COLUMN maxEntries INTEGER DEFAULT 0');
                executeSQL('ALTER TABLE entries ADD COLUMN authors TEXT');
                executeSQL('ALTER TABLE feeds ADD COLUMN rowIndex INTEGER');
                executeSQL('ALTER TABLE feeds ADD COLUMN parent TEXT');
                executeSQL('ALTER TABLE feeds ADD COLUMN isFolder INTEGER');
                executeSQL('ALTER TABLE feeds ADD COLUMN RDF_URI TEXT');
            }
            catch (ex) { }
            // Fall through...

        // To 0.8.
        case 1:
            executeSQL('ALTER TABLE entries ADD COLUMN secondaryID TEXT');
            executeSQL('UPDATE entries SET content = summary, summary = "" WHERE content = ""');
            // Fall through...

        // To 1.0 beta 1
        case 2:
            try {
                executeSQL('ALTER TABLE entries ADD COLUMN updated INTEGER DEFAULT 0');
            }
            catch (ex) { }
            // Fall through...

        // To 1.0
        case 3:
            executeSQL('DROP INDEX IF EXISTS entries_id_index');
            executeSQL('DROP INDEX IF EXISTS feeds_feedID_index');
            // Fall through...

        // To 1.2a1
        case 4:
            this.recomputeIDs();
            this.recreateFeedsTable();
            executeSQL('ALTER TABLE entries ADD COLUMN bookmarkID INTEGER DEFAULT -1');
            // Fall through...

        // To 1.2b2
        case 5:
        case 6:
            if (gConnection.schemaVersion > 4)
                executeSQL('ALTER TABLE feeds ADD COLUMN markModifiedEntriesUnread INTEGER DEFAULT 1');
            // Fall through...

        // To 1.2b3
        case 7:
            this.migrateEntries();
            this.bookmarkStarredEntries();
            // Fall through...

        // To 1.2
        case 8:
            executeSQL('DROP INDEX IF EXISTS entries_feedID_index');
            executeSQL('CREATE INDEX IF NOT EXISTS entries_feedID_date_index ON entries (feedID, date) ');

        }

        gConnection.schemaVersion = DATABASE_VERSION;
    },


    recreateFeedsTable: function BriefStorage_recreateFeedsTable() {
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

        gConnection.beginTransaction();
        try {
            executeSQL('CREATE TABLE feeds_copy ('+OLD_COLS+')                               ');
            executeSQL('INSERT INTO feeds_copy SELECT '+OLD_COLS+' FROM feeds                ');
            executeSQL('DROP TABLE feeds                                                     ');
            executeSQL('CREATE TABLE feeds ('+FEEDS_TABLE_SCHEMA+')                          ');
            executeSQL('INSERT INTO feeds ('+NEW_COLS+') SELECT '+OLD_COLS+' FROM feeds_copy ');
            executeSQL('DROP TABLE feeds_copy                                                ');
        }
        catch (ex) {
            reportError(ex, true);
        }
        finally {
            gConnection.commitTransaction();
        }
    },


    migrateEntries: function BriefStorage_migrateEntries() {
        var dbVersion = gConnection.schemaVersion;

        gConnection.beginTransaction();
        try {
            let cols = 'id, feedID, secondaryID, providedID, entryURL, date, authors, '+
                       'read, updated, starred, deleted, bookmarkID, title, content   ';

            executeSQL('CREATE TABLE entries_copy ('+cols+')                  ');
            executeSQL('INSERT INTO entries_copy SELECT '+cols+' FROM entries ');
            executeSQL('DROP TABLE entries                                    ');

            this.setupDatabase();

            let fromCols = 'feedID, providedID, entryURL, date, read, updated,       '+
                           'starred, deleted, bookmarkID, id, secondaryID            ';
            let toCols =   'feedID, providedID, entryURL, date, read, updated,       '+
                           'starred, deleted, bookmarkID, primaryHash, secondaryHash ';

            executeSQL('INSERT INTO entries ('+toCols+')                                '+
                       'SELECT '+fromCols+' FROM entries_copy ORDER BY rowid            ');
            executeSQL('INSERT INTO entries_text (title, content, authors)              '+
                       'SELECT title, content, authors FROM entries_copy ORDER BY rowid ');
            executeSQL('DROP TABLE entries_copy                                         ');
        }
        catch (ex) {
            reportError(ex, true);
        }
        finally {
            gConnection.commitTransaction();
        }

        executeSQL('VACUUM');
    },

    bookmarkStarredEntries: function BriefStorage_bookmarkStarredEntries() {
        var folder = gBms.unfiledBookmarksFolder;
        var select = gStm.selectStarredEntries;
        var sql = 'UPDATE entries SET starred = 1, bookmarkID = :bookmarkID '+
                  'WHERE id = :entryID                                      ';
        var update = createStatement(sql);

        gConnection.beginTransaction();
        try {
            while (select.step()) {
                let alreadyBookmarked = false;
                let uri = newURI(select.row.entryURL);
                let title = select.row.title;

                // Look for existing bookmarks for entry's URI.
                if (gBms.isBookmarked(uri)) {
                    let bookmarkIDs = gBms.getBookmarkIdsForURI(uri, {});
                    for each (bookmarkID in bookmarkIDs) {
                        let parent = gBms.getFolderIdForItem(bookmarkID);
                        if (!isLivemark(parent)) {
                            alreadyBookmarked = true;
                            break;
                        }
                    }
                }

                if (alreadyBookmarked) {
                    this.starEntry(true, select.row.id, bookmarkID);
                }
                else {
                    let bookmarkID = gBms.insertBookmark(folder, uri, gBms.DEFAULT_INDEX,
                                                         title);
                    update.params.entryID = select.row.id;
                    update.params.bookmarkID = bookmarkID;
                    update.execute();
                }
            }
        }
        catch (ex) {
            reportError(ex);
        }
        finally {
            select.reset();
            gConnection.commitTransaction();
        }
    },


    recomputeIDs: function BriefStorage_recomputeIDs() {
        var hashStringFunc = {
            QueryInterface: XPCOMUtils.generateQI([Ci.mozIStorageFunction]),
            onFunctionCall: function(aArgs) hashString(aArgs.getUTF8String(0))
        }
        var generateEntryHashFunc = {
            QueryInterface: XPCOMUtils.generateQI([Ci.mozIStorageFunction]),
            onFunctionCall: function(aArgs) hashString(aArgs.getUTF8String(0) +
                                                       aArgs.getUTF8String(1))
        }

        gConnection.createFunction('hashString', 1, hashStringFunc);
        gConnection.createFunction('generateEntryHash', 2, generateEntryHashFunc);

        gConnection.beginTransaction();
        try {
            executeSQL('UPDATE OR IGNORE entries                                          ' +
                       'SET id = generateEntryHash(feedID, providedID)                    ' +
                       'WHERE rowid IN (                                                  ' +
                       '   SELECT entries.rowid                                           ' +
                       '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
                       '   WHERE entries.date >= feeds.oldestAvailableEntryDate AND       ' +
                       '         entries.providedID != ""                                 ' +
                       ')                                                                 ');
            executeSQL('UPDATE OR IGNORE feeds SET feedID = hashString(feedURL) WHERE isFolder = 0');
        }
        catch (ex) {
            reportError(ex, true);
        }
        finally {
            gConnection.commitTransaction();
        }
    },


    // nsIBriefStorage
    getFeed: function BriefStorage_getFeed(aFeedID) {
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


    getFeedByBookmarkID: function BriefStorage_getFeedByBookmarkID(aBookmarkID) {
        var foundFeed = null;
        var feeds = this.getAllFeeds(true);
        for (var i = 0; i < feeds.length; i++) {
            if (feeds[i].bookmarkID == aBookmarkID) {
                foundFeed = feeds[i];
                break;
            }
        }
        return foundFeed;
    },


    // nsIBriefStorage
    getAllFeeds: function BriefStorage_getAllFeeds(aIncludeFolders) {
        if (!this.feedsCache)
            this.buildFeedsCache();

        return aIncludeFolders ? this.feedsAndFoldersCache : this.feedsCache;
    },


    buildFeedsCache: function BriefStorage_buildFeedsCache() {
        this.feedsCache = [];
        this.feedsAndFoldersCache = [];

        var cols = ['feedID', 'feedURL', 'websiteURL', 'title', 'subtitle', 'imageURL',
                    'imageLink', 'imageTitle', 'dateModified', 'favicon', 'lastUpdated',
                    'oldestEntryDate', 'rowIndex', 'parent', 'isFolder', 'bookmarkID',
                    'entryAgeLimit', 'maxEntries', 'updateInterval', 'markModifiedEntriesUnread'];

        var select = createStatement('SELECT ' + cols.join(', ') + ' FROM feeds ' +
                                     'WHERE hidden = 0 ORDER BY rowIndex ASC    ');
        try {
            while (select.step()) {
                var feed = Cc['@ancestor/brief/feed;1'].createInstance(Ci.nsIBriefFeed);
                for (let i = 0; i < cols.length; i++)
                    feed[cols[i]] = select.row[cols[i]]

                this.feedsAndFoldersCache.push(feed);
                if (!feed.isFolder)
                    this.feedsCache.push(feed);
            }
        }
        finally {
            select.reset();
        }
    },


    // nsIBriefStorage
    getAllTags: function BriefStorage_getAllTags() {
        try {
            var tags = [];

            var sql = 'SELECT entry_tags.tagName                                             '+
                      'FROM entry_tags INNER JOIN entries ON entry_tags.entryID = entries.id '+
                      'WHERE entries.deleted = :deletedState                                 '+
                      'ORDER BY entry_tags.tagName                                           ';
            var select = createStatement(sql);
            select.params.deletedState = ENTRY_STATE_NORMAL;

            while (select.step()) {
                let tag = select.row.tagName;
                if (tag != tags[tags.length - 1])
                    tags.push(tag);
            }
        }
        finally {
            select.reset();
        }

        return tags;
    },


    newEntries: [],
    updatedEntries: [],

    // nsIBriefStorage
    updateFeed: function BriefStorage_updateFeed(aFeed) {
        this.newEntries = [];
        this.updatedEntries = [];
        var dateModified = new Date(aFeed.wrappedFeed.updated).getTime();

        if (!dateModified || dateModified > this.getFeed(aFeed.feedID).dateModified) {
            aFeed.oldestEntryDate = Date.now();
            var downloadedEntries = aFeed.entries;

            gConnection.beginTransaction();
            try {
                for (let i = 0; i < downloadedEntries.length; i++) {
                    let entry = downloadedEntries[i];

                    this.processEntry(entry, aFeed);

                    if (entry.date && entry.date < aFeed.oldestEntryDate)
                        aFeed.oldestEntryDate = entry.date;
                }

                let stmt = gStm.updateFeed;
                let cachedFeed = this.getFeed(aFeed.feedID);

                // Update the properties of the feed (and the cache).
                stmt.params.websiteURL  = cachedFeed.websiteURL  = aFeed.websiteURL;
                stmt.params.subtitle    = cachedFeed.subtitle    = aFeed.subtitle;
                stmt.params.imageURL    = cachedFeed.imageURL    = aFeed.imageURL;
                stmt.params.imageLink   = cachedFeed.imageLink   = aFeed.imageLink;
                stmt.params.imageTitle  = cachedFeed.imageTitle  = aFeed.imageTitle;
                stmt.params.favicon     = cachedFeed.favicon     = aFeed.favicon;
                stmt.params.lastUpdated = cachedFeed.lastUpdated = Date.now();
                stmt.params.dateModified = cachedFeed.dateModified = dateModified;
                stmt.params.oldestEntryDate = cachedFeed.oldestEntryDate = aFeed.oldestEntryDate;
                stmt.params.feedID = aFeed.feedID;

                stmt.execute();
            }
            catch (ex) {
                reportError(ex);
            }
            finally {
                gConnection.commitTransaction();
            }
        }

        var subject = Cc['@mozilla.org/variant;1'].createInstance(Ci.nsIWritableVariant);
        subject.setAsInt32(this.newEntries.length);
        gObserverService.notifyObservers(subject, 'brief:feed-updated', aFeed.feedID);

        if (this.newEntries.length) {
            let query = new BriefQuery();
            query.entries = this.newEntries;
            let list = query.getEntryList();

            for each (observer in this.observers)
                observer.onEntriesAdded(list);
        }

        if (this.updatedEntries.length) {
            let query = new BriefQuery();
            query.entries = this.updatedEntries;
            let list = query.getEntryList();

            for each (observer in this.observers)
                observer.onEntriesUpdated(list);
        }
    },


    processEntry: function BriefStorage_processEntry(aEntry, aFeed) {
        var content = aEntry.content || aEntry.summary;
        var title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags

        // This function checks whether a downloaded entry is already in the database or
        // it is a new one. To do this we need a way to uniquely identify entries. Many
        // feeds don't provide unique identifiers for their entries, so we have to use
        // hashes for this purpose. There are two hashes.
        // The primary hash is used as a standard unique ID throught the codebase.
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
        var primarySet = providedID ? [aFeed.feedID, providedID]
                                    : [aFeed.feedID, aEntry.entryURL];
        var secondarySet = [aFeed.feedID, aEntry.entryURL];

        // Special case for MediaWiki feeds: include the date in the hash. In
        // "Recent changes" feeds, entries for subsequent edits of a page differ
        // only in date (not in URL or GUID).
        var generator = aFeed.wrappedFeed.generator;
        if (generator && generator.agent.match('MediaWiki')) {
            primarySet.push(aEntry.date);
            secondarySet.push(aEntry.date);
        }

        var primaryHash = hashString(primarySet.join(''));
        var secondaryHash = hashString(secondarySet.join(''));

        // Look up if the entry is already present in the database.
        try {
            if (providedID) {
                var select = gStm.getEntryByPrimaryHash;
                select.params.primaryHash = primaryHash;
            }
            else {
                select = gStm.getEntryBySecondaryHash;
                select.params.secondaryHash = secondaryHash;
            }

            if (select.step()) {
                var storedEntryID = select.row.id;
                var storedEntryDate = select.row.date;
                var isStoredEntryRead = !!select.row.read;
            }
        }
        finally {
            select.reset();
        }

        // If the entry is already present in the database, compare if the downloaded
        // entry has a newer date than the stored one and if so, update it.
        // Otherwise, insert it if it isn't stored yet.
        if (storedEntryID) {
            if (aEntry.date && storedEntryDate < aEntry.date) {
                let markUnread = this.getFeed(aFeed.feedID).markModifiedEntriesUnread;
                var update = gStm.updateEntry;
                update.params.date = aEntry.date;
                update.params.read = markUnread || !isStoredEntryRead ? 0 : 1;
                update.params.id = storedEntryID;
                update.execute();

                update = gStm.updateEntryText;
                update.params.title = aEntry.title;
                update.params.content = content;
                update.params.authors = aEntry.authors;
                update.params.id = storedEntryID;
                update.execute();

                this.updatedEntries.push(storedEntryID);
            }
        }
        else {
            var insert = gStm.insertEntry;
            insert.params.feedID = aFeed.feedID;
            insert.params.primaryHash = primaryHash;
            insert.params.secondaryHash = secondaryHash;
            insert.params.providedID = providedID;
            insert.params.entryURL = aEntry.entryURL;
            insert.params.date = aEntry.date || Date.now();
            insert.execute();

            insert = gStm.insertEntryText;
            insert.params.title = aEntry.title;
            insert.params.content = content;
            insert.params.authors = aEntry.authors;
            insert.execute();

            let entryID = gConnection.lastInsertRowID;

            let uri = newURI(aEntry.entryURL);
            if (gBms.isBookmarked(uri)) {
                let bookmarkIDs = gBms.getBookmarkIdsForURI(uri, {});

                let bm = bookmarkIDs.filter(isNormalBookmark)[0];
                if (bm) {
                    this.starEntry(true, entryID, bm);
                    this.refreshTagsForEntry(entryID, bookmarkIDs);
                }
            }

            this.newEntries.push(entryID);
        }
    },


    // nsIBriefStorage
    setFeedOptions: function BriefStorage_setFeedOptions(aFeed) {
        var update = createStatement('UPDATE feeds                                ' +
                                     'SET entryAgeLimit  = :entryAgeLimit,        ' +
                                     '    maxEntries     = :maxEntries,           ' +
                                     '    updateInterval = :updateInterval,       ' +
                                     '    markModifiedEntriesUnread = :markUnread ' +
                                     'WHERE feedID = :feedID                      ');
        update.params.entryAgeLimit = aFeed.entryAgeLimit;
        update.params.maxEntries = aFeed.maxEntries;
        update.params.updateInterval = aFeed.updateInterval;
        update.params.markUnread = aFeed.markModifiedEntriesUnread ? 1 : 0;
        update.params.feedID = aFeed.feedID;
        update.execute();

        // Update the cache if neccassary (it may not be if nsIBriefFeed instance that was
        // passed to us was itself taken from the cache).
        var feed = this.getFeed(aFeed.feedID);
        if (feed != aFeed) {
            feed.entryAgeLimit = aFeed.entryAgeLimit;
            feed.maxEntries = aFeed.maxEntries;
            feed.updateInterval = aFeed.updateInterval;
            feed.markModifiedEntriesUnread = aFeed.markModifiedEntriesUnread;
        }
    },


    // nsIBriefStorage
    compactDatabase: function BriefStorage_compactDatabase() {
        this.purgeEntries(false);
        executeSQL('VACUUM');
    },


    // Moves expired entries to Trash and permanently removes
    // the deleted items from database.
    purgeEntries: function BriefStorage_purgeEntries(aDeleteExpired) {
        var removeEntries = createStatement(
            'DELETE FROM entries                                                      ' +
            'WHERE id IN (                                                            ' +
            '   SELECT entries.id                                                     ' +
            '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID        ' +
            '   WHERE (entries.deleted = :oldState AND feeds.oldestEntryDate > entries.date) ' +
            '         OR (:now - feeds.hidden > :retentionTime AND feeds.hidden != 0)        ' +
            ')                                                                               ');
        var removeFeeds = createStatement(
            'DELETE FROM feeds                                ' +
            'WHERE :now - feeds.hidden > :retentionTime AND   ' +
            '      feeds.hidden != 0                          ');

        gConnection.beginTransaction()
        try {
            if (aDeleteExpired) {
                this.expireEntriesByAgeGlobal();
                this.expireEntriesByAgePerFeed();
                this.expireEntriesByNumber();
            }

            removeEntries.params.oldState = ENTRY_STATE_DELETED;
            removeEntries.params.now = Date.now();
            removeEntries.params.retentionTime = DELETED_FEEDS_RETENTION_TIME;
            removeEntries.execute();

            removeFeeds.params.now = Date.now();
            removeFeeds.params.retentionTime = DELETED_FEEDS_RETENTION_TIME;
            removeFeeds.execute();
        }
        catch (ex) {
            reportError(ex);
        }
        finally {
            gConnection.commitTransaction();
        }

        // Prefs can only store longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        gPrefs.setIntPref('database.lastPurgeTime', now);
    },


    // Expire old entries in feeds that don't have per-feed setting enabled.
    expireEntriesByAgeGlobal: function BriefStorage_expireEntriesByAgeGlobal() {
        var shouldExpire = gPrefs.getBoolPref('database.expireEntries');
        if (!shouldExpire)
            return;

        var expirationAge = gPrefs.getIntPref('database.entryExpirationAge');
        // expirationAge is in days, convert it to miliseconds.
        var edgeDate = Date.now() - expirationAge * 86400000;

        var statement = createStatement(
            'UPDATE entries SET deleted = :newState                            ' +
            'WHERE id IN (                                                     ' +
            '   SELECT entries.id                                              ' +
            '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
            '   WHERE entries.deleted = :oldState AND                          ' +
            '         feeds.entryAgeLimit = 0 AND                              ' +
            '         entries.starred = 0 AND                                  ' +
            '         entries.date < :edgeDate                                 ' +
            ')                                                                 ');
        statement.params.newState = ENTRY_STATE_TRASHED;
        statement.params.oldState = ENTRY_STATE_NORMAL;
        statement.params.edgeDate = edgeDate;
        statement.execute();
    },


    // Delete old entries based on the per-feed limit.
    expireEntriesByAgePerFeed: function BriefStorage_expireEntriesByAgePerFeed() {
        var statement = createStatement('UPDATE entries SET deleted = :newState  ' +
                                        'WHERE entries.deleted = :oldState AND   ' +
                                        '      starred = 0 AND                   ' +
                                        '      entries.date < :edgeDate AND      ' +
                                        '      feedID = :feedID                  ');
        var feeds = this.getAllFeeds();
        var now = Date.now();

        for each (feed in feeds) {
            if (feed.entryAgeLimit > 0) {
                var edgeDate = now - feed.entryAgeLimit * 86400000;
                statement.params.newState = ENTRY_STATE_TRASHED;
                statement.params.oldState = ENTRY_STATE_NORMAL;
                statement.params.edgeDate = edgeDate;
                statement.params.feedID = feed.feedID;
                statement.execute();
            }
        }
    },


    // Delete entries exceeding the maximum amount specified by maxStoredEntries pref.
    expireEntriesByNumber: function BriefStorage_expireEntriesByNumber() {
        if (!gPrefs.getBoolPref('database.limitStoredEntries'))
            return;

        var maxEntries = gPrefs.getIntPref('database.maxStoredEntries');

        var expireEntries = createStatement('UPDATE entries                    ' +
                                            'SET deleted = :newState           ' +
                                            'WHERE rowid IN (                  ' +
                                            '    SELECT rowid                  ' +
                                            '    FROM entries                  ' +
                                            '    WHERE deleted = :oldState AND ' +
                                            '          starred = 0 AND         ' +
                                            '          feedID = :feedID        ' +
                                            '    ORDER BY date ASC             ' +
                                            '    LIMIT :limit                  ' +
                                            ')                                 ');
        var getEntryCount = createStatement('SELECT COUNT(1) AS count FROM entries  ' +
                                            'WHERE feedID = :feedID AND             ' +
                                            '      starred = 0 AND                  ' +
                                            '      deleted = :deleted               ');

        var feeds = this.getAllFeeds();
        for each (feed in feeds) {
            getEntryCount.feedID = feed.feedID;
            getEntryCount.deleted = ENTRY_STATE_NORMAL;
            getEntryCount.step();
            let entryCount = getEntryCount.row.count;

            if (entryCount - maxEntries > 0) {
                expireEntries.params.newState = ENTRY_STATE_TRASHED;
                expireEntries.params.oldState = ENTRY_STATE_NORMAL;
                expireEntries.params.feedID = feed.feedID;
                expireEntries.params.limit = entryCount - maxEntries;
                expireEntries.execute();
            }
        }
    },


    // nsIObserver
    observe: function BriefStorage_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'profile-after-change':
                if (aData === 'startup') {
                    this.instantiate();
                    gObserverService.removeObserver(this, 'profile-after-change');
                }
                break;

            case 'quit-application':
                // Integer prefs are longs while Date is a long long.
                var now = Math.round(Date.now() / 1000);
                var lastPurgeTime = gPrefs.getIntPref('database.lastPurgeTime');
                if (now - lastPurgeTime > PURGE_ENTRIES_INTERVAL)
                    this.purgeEntries(true);

                gBms.removeObserver(this);
                gPrefs.removeObserver('', this);
                gObserverService.removeObserver(this, 'quit-application');

                this.syncDelayTimer = null;
                break;

            case 'timer-callback':
                this.livemarksSyncPending = false;
                this.syncWithLivemarks();
                break;

            case 'nsPref:changed':
                if (aData == 'homeFolder') {
                    this.homeFolderID = gPrefs.getIntPref('homeFolder');
                    this.syncWithLivemarks();
                }
                break;
        }
    },


    // nsIBriefStorage
    syncWithLivemarks: function BriefStorage_syncWithLivemarks() {
        new LivemarksSynchronizer();
    },


    observers: [],

    // nsIBriefStorage
    addObserver: function BriefStorage_addObserver(aObserver) {
        this.observers.push(aObserver);
    },

    // nsIBriefStorage
    removeObserver: function BriefStorage_removeObserver(aObserver) {
        var index = this.observers.indexOf(aObserver);
        if (index !== -1)
            this.observers.splice(index, 1);
    },


    homeFolderID: -1,

    // State properties uses by the bookmarks observer.
    bookmarksObserverBatching: false,
    homeFolderContentModified: false,
    livemarksSyncPending: false,

    get syncDelayTimer BriefStorage_syncDelayTimer() {
        if (!this.__syncDelayTimer)
            this.__syncDelayTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        return this.__syncDelayTimer;
    },

    // nsINavBookmarkObserver
    onEndUpdateBatch: function BriefStorage_onEndUpdateBatch() {
        this.bookmarksObserverBatching = false;
        if (this.homeFolderContentModified)
            this.delayedLivemarksSync();
        this.homeFolderContentModified = false;
    },

    // nsINavBookmarkObserver
    onBeginUpdateBatch: function BriefStorage_onBeginUpdateBatch() {
        this.bookmarksObserverBatching = true;
    },

    // nsINavBookmarkObserver
    onItemAdded: function BriefStorage_onItemAdded(aItemID, aFolder, aIndex) {
        if (isFolder(aItemID) && isInHomeFolder(aFolder)) {
            this.delayedLivemarksSync();
            return;
        }

        // We only care about plain bookmarks and tags.
        if (isLivemark(aFolder) || !isBookmark(aItemID))
            return;

        // Find entries with the same URI as the added item and tag or star them.
        gConnection.beginTransaction();
        try {
            var url = gBms.getBookmarkURI(aItemID).spec;
            var isTag = isTagFolder(aFolder);
            var changedEntries = [];

            for each (entry in this.getEntriesByURL(url)) {
                if (isTag) {
                    var tagName = gBms.getItemTitle(aFolder);
                    this.tagEntry(true, entry.id, tagName, aItemID);
                }
                else {
                    this.starEntry(true, entry.id, aItemID);
                }

                changedEntries.push(entry);
            }
        }
        catch (ex) {
            reportError(ex, true);
        }
        finally {
            gConnection.commitTransaction();
        }

        if (changedEntries.length) {
            let entryIDs = changedEntries.map(function(e) e.id);
            if (isTag)
                this.notifyOfEntriesTagged(entryIDs, true, tagName);
            else
                this.notifyOfEntriesStarred(entryIDs, true);
        }
    },

    // nsINavBookmarkObserver
    onItemRemoved: function BriefStorage_onItemRemoved(aItemID, aFolder, aIndex) {
        if (this.isLivemarkStored(aItemID) || aItemID == this.homeFolderID) {
            this.delayedLivemarksSync();
            return;
        }

        // We only care about plain bookmarks and tags, but we can't check the type
        // of the removed item, except for if it was a part of a Live Bookmark.
        if (isLivemark(aFolder))
            return;

        // Find entries with bookmarkID of the removed item and untag/unstar them.
        gConnection.beginTransaction();
        try {
            var changedEntries = [];
            var isTag = isTagFolder(aFolder);

            if (isTag) {
                for each (entry in this.getEntriesByTagID(aItemID)) {
                    var tagName = gBms.getItemTitle(aFolder);
                    this.tagEntry(false, entry.id, tagName);
                    changedEntries.push(entry)
                }
            }
            else {
                let entries = this.getEntriesByBookmarkID(aItemID);

                // Look for other bookmarks for this URI.
                if (entries.length) {
                    let uri = newURI(entries[0].url);
                    var bookmarks = gBms.getBookmarkIdsForURI(uri, {}).
                                         filter(isNormalBookmark);
                }

                for each (entry in entries) {
                    if (bookmarks.length) {
                        // If there is another bookmark for this URI, don't unstar the
                        // entry, but update its bookmarkID to point to that bookmark.
                        this.starEntry(true, entry.id, bookmarks[0]);
                    }
                    else {
                        this.starEntry(false, entry.id);
                        changedEntries.push(entry);
                    }
                }
            }
        }
        catch (ex) {
            reportError(ex, true);
        }
        finally {
            gConnection.commitTransaction();
        }

        if (changedEntries.length) {
            let entryIDs = changedEntries.map(function(e) e.id);
            if (isTag)
                this.notifyOfEntriesTagged(entryIDs, false, tagName);
            else
                this.notifyOfEntriesStarred(entryIDs, false);
        }
    },

    // nsINavBookmarkObserver
    onItemMoved: function BriefStorage_onItemMoved(aItemID, aOldParent, aOldIndex,
                                                   aNewParent, aNewIndex) {
        var wasInHome = this.isLivemarkStored(aItemID);
        var isInHome = isFolder(aItemID) && isInHomeFolder(aNewParent);
        if (wasInHome || isInHome)
            this.delayedLivemarksSync();
    },

    // nsINavBookmarkObserver
    onItemChanged: function BriefStorage_onItemChanged(aItemID, aProperty,
                                                       aIsAnnotationProperty, aValue) {
        switch (aProperty) {
        case 'title':
            let feed = this.getFeedByBookmarkID(aItemID);
            if (feed) {
                gStm.setFeedTitle.params.title = aValue;
                gStm.setFeedTitle.params.feedID = feed.feedID;
                gStm.setFeedTitle.execute();

                feed.title = aValue; // Update the cache.

                gObserverService.notifyObservers(null, 'brief:feed-title-changed', feed.feedID);
            }
            else if (isTagFolder(aItemID)) {
                this.renameTag(aItemID, aValue);
            }
            break;

        case 'livemark/feedURI':
            if (this.isLivemarkStored(aItemID))
                this.delayedLivemarksSync();
            break;

        case 'uri':
            // Unstar any entries with the old URI.
            let entries = this.getEntriesByBookmarkID(aItemID);
            for each (entry in entries)
                this.starEntry(false, entry.id);

            if (entries.length)
                this.notifyOfEntriesStarred(entries.map(function(e) e.id), false);

            // Star any entries with the new URI.
            entries = this.getEntriesByURL(aValue);
            for each (entry in entries)
                this.starEntry(true, entry.id, aItemID);

            if (entries.length)
                this.notifyOfEntriesStarred(entries.map(function(e) e.id), true);

            break;
        }
    },

    // nsINavBookmarkObserver
    onItemVisited: function BriefStorage_aOnItemVisited(aItemID, aVisitID, aTime) { },

    isLivemarkStored: function BriefStorage_isLivemarkStored(aItemID) {
        return !!this.getFeedByBookmarkID(aItemID);
    },

    delayedLivemarksSync: function BriefStorage_delayedLivemarksSync() {
        if (this.bookmarksObserverBatching) {
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
     * Sets starred status of an entry.
     *
     * @param aState      New state. TRUE for starred, FALSE for not starred.
     * @param aEntryID    Subject entry.
     * @param aBookmarkID ItemId of the corresponding bookmark in Places database.
     */
    starEntry: function BriefStorage_starEntry(aState, aEntryID, aBookmarkID) {
        if (aState) {
            gStm.starEntry.params.bookmarkID = aBookmarkID;
            gStm.starEntry.params.entryID = aEntryID;
            gStm.starEntry.execute();
        }
        else {
            gStm.unstarEntry.params.id = aEntryID;
            gStm.unstarEntry.execute();
        }
    },

    /**
     * Adds or removes a tag for an entry.
     *
     * @param aState   TRUE to add the tag, FALSE to remove it.
     * @param aEntryID Subject entry.
     * @param aTagName Name of the tag.
     * @param aTagID   ItemId of the tag's bookmark item in Places database. Only
     *                 required when adding a tag.
     */
    tagEntry: function BriefStorage_tagEntry(aState, aEntryID, aTagName, aTagID) {
        if (aState) {
            gStm.tagEntry.params.entryID = aEntryID;
            gStm.tagEntry.params.tagName = aTagName;
            gStm.tagEntry.params.tagID = aTagID;
            gStm.tagEntry.execute();
        }
        else {
            gStm.untagEntry.params.entryID = aEntryID;
            gStm.untagEntry.params.tagName = aTagName;
            gStm.untagEntry.execute();
        }

        // Refresh the serialized list of tags stored in entries_text table.
        var tags = this.getTagsForEntry(aEntryID);
        gStm.setSerializedTagList.params.tags = tags.join(', ');
        gStm.setSerializedTagList.params.entryID = aEntryID;
        gStm.setSerializedTagList.execute();
    },


    /**
     * Refreshes tags for an entry by comparing stored tags with the current tags in the
     * Places database. This function should only be used when the caller doesn't know
     * which tags may have been changed, otherwise tagEntry() should be used. This
     * function does not notify observers of any changes it makes.
     *
     * @param aEntryID    Entry whose tags to refresh.
     * @param aBoookmarks Array of itemIds of bookmark items for the entry's URI.
     * @returns An array of added tags and an array of removed tags.
     */
    refreshTagsForEntry: function BriefStorage_refreshTagsForEntry(aEntryID, aBookmarks) {
        var addedTags = [];
        var removedTags = [];

        var storedTags = this.getTagsForEntry(aEntryID);

        // Get the list of current tags for this entry's URI.
        var currentTagNames = [];
        var currentTagIDs = [];
        for each (itemID in aBookmarks) {
            let parent = gBms.getFolderIdForItem(itemID);
            if (isTagFolder(parent)) {
                currentTagIDs.push(itemID);
                currentTagNames.push(gBms.getItemTitle(parent));
            }
        }

        for each (tag in storedTags) {
            if (currentTagNames.indexOf(tag) === -1) {
                this.tagEntry(false, aEntryID, tag);
                removedTags.push(tag);
            }
        }

        for (let i = 0; i < currentTagNames.length; i++) {
            let tag = currentTagNames[i];
            if (storedTags.indexOf(tag) === -1) {
                this.tagEntry(true, aEntryID, tag, currentTagIDs[i])
                addedTags.push(tag);
            }
        }

        return [addedTags, removedTags];
    },


    /**
     * Syncs tags when a tag folder is renamed by removing tags with the old name
     * and re-tagging the entries using the new one.
     *
     * @param aTagFolderID itemId of the tag folder that was renamed.
     * @param aNewName     New name of the tag folder, i.e. new name of the tag.
     */
    renameTag: function BriefStorage_renameTag(aTagFolderID, aNewName) {
        try {
            // Get bookmarks in the renamed tag folder.
            var options = gPlaces.history.getNewQueryOptions();
            var query = gPlaces.history.getNewQuery();
            query.setFolders([aTagFolderID], 1);
            var result = gPlaces.history.executeQuery(query, options);
            result.root.containerOpen = true;

            var oldTagName = '';

            for (let i = 0; i < result.root.childCount; i++) {
                let tagID = result.root.getChild(i).itemId;
                let entries = this.getEntriesByTagID(tagID).
                                   map(function(e) e.id);

                for each (entry in entries) {
                    if (!oldTagName) {
                        // The bookmark observer doesn't provide the old name,
                        // so we have to look it up in our database.
                        gStm.getNameForTagID.params.tagID = tagID;
                        gStm.getNameForTagID.step();
                        oldTagName = gStm.getNameForTagID.row.tagName;
                    }

                    this.tagEntry(false, entry, oldTagName);
                    this.tagEntry(true, entry, aNewName, tagID);
                }

                if (entries.length) {
                    this.notifyOfEntriesTagged(entries, false, oldTagName);
                    this.notifyOfEntriesTagged(entries, true, aNewName);
                }
            }

            result.root.containerOpen = false;
        }
        finally {
            gStm.getNameForTagID.reset();
        }
    },


    getTagsForEntry: function BriefStorage_getTagsForEntry(aEntryID) {
        try {
            var tags = [];
            gStm.getTagsForEntry.params.entryID = aEntryID;
            while (gStm.getTagsForEntry.step())
                tags.push(gStm.getTagsForEntry.row.tagName);
        }
        finally {
            gStm.getTagsForEntry.reset();
        }
        return tags;
    },


    notifyOfEntriesStarred: function BriefStorage_notifyOfEntriesStarred(aEntries, aNewState) {
        var query = new BriefQuery();
        query.entries = aEntries;
        var list = query.getEntryList();

        for each (observer in this.observers)
            observer.onEntriesStarred(list, aNewState);
    },

    notifyOfEntriesTagged: function BriefStorage_notifyOfEntriesTagged(aEntries, aNewState,
                                                                       aChangedTag) {
        var query = new BriefQuery();
        query.entries = aEntries;
        var list = query.getEntryList();

        for each (observer in this.observers)
            observer.onEntriesTagged(list, aNewState, aChangedTag);
    },

    getEntriesByURL: function BriefStorage_getEntriesByURL(aURL) {
        try {
            var entries = [];
            var select = gStm.selectEntriesByURL;
            select.params.url = aURL;
            while (select.step()) {
                entries.push({ id: select.row.id,
                               starred: select.row.starred });
            }
        }
        finally {
            select.reset();
        }

        return entries;
    },

    getEntriesByBookmarkID: function BriefStorage_getEntriesByBookmarkID(aBookmarkID) {
        try {
            var entries = [];
            var select = gStm.selectEntriesByBookmarkID;
            select.params.bookmarkID = aBookmarkID;
            while (select.step()) {
                entries.push({ id: select.row.id,
                               url: select.row.entryURL,
                               starred: select.row.starred });
            }
        }
        finally {
            select.reset();
        }

        return entries;
    },

    getEntriesByTagID: function BriefStorage_getEntriesByTagID(aTagID) {
        try {
            var entries = [];
            var select = gStm.selectEntriesByTagID;
            select.params.tagID = aTagID;
            while (select.step()) {
                entries.push({ id: select.row.id,
                               url: select.row.entryURL });
            }
        }
        finally {
            select.reset();
        }

        return entries;
    },


    classDescription: 'Database component for the Brief extension',
    classID: Components.ID('{4C468DA8-7F30-11DB-A690-EBF455D89593}'),
    contractID: '@ancestor/brief/storage;1',
    _xpcom_categories: [ { category: 'app-startup', service: true } ],
    _xpcom_factory: {
        createInstance: function(aOuter, aIID) {
            if (aOuter != null)
                throw Components.results.NS_ERROR_NO_AGGREGATION;

            if (!gStorageService)
                gStorageService = new BriefStorageService();

            return gStorageService.QueryInterface(aIID);
        }
    },
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIBriefStorage,
                                           Ci.nsIObserver,
                                           Ci.nsINavBookmarkObserver])
}


// Cached statements.
var gStm = {

    get updateFeed() {
        var sql = 'UPDATE feeds                                                  ' +
                  'SET websiteURL = :websiteURL, subtitle = :subtitle,           ' +
                  '    imageURL = :imageURL, imageLink = :imageLink,             ' +
                  '    imageTitle = :imageTitle, favicon = :favicon,             ' +
                  '    lastUpdated = :lastUpdated, dateModified = :dateModified, ' +
                  '    oldestEntryDate = :oldestEntryDate                        ' +
                  'WHERE feedID = :feedID                                        ';
        delete this.updateFeed;
        return this.updateFeed = createStatement(sql);
    },

    get setFeedTitle() {
        var sql = 'UPDATE feeds SET title = :title WHERE feedID = :feedID';
        delete this.setFeedTitle;
        return this.setFeedTitle = createStatement(sql);
    },

    get insertEntry() {
        var sql = 'INSERT INTO entries (feedID, primaryHash, secondaryHash, providedID, entryURL, date) ' +
                  'VALUES (:feedID, :primaryHash, :secondaryHash, :providedID, :entryURL, :date)        ';
        delete this.insertEntry;
        return this.insertEntry = createStatement(sql);
    },

    get insertEntryText() {
        var sql = 'INSERT INTO entries_text (rowid, title, content, authors) ' +
                  'VALUES(last_insert_rowid(), :title, :content, :authors)   ';
        delete this.insertEntryText;
        return this.insertEntryText = createStatement(sql);
    },

    get updateEntry() {
        var sql = 'UPDATE entries SET date = :date, read = :read, updated = 1 '+
                  'WHERE id = :id                                             ';
        delete this.updateEntry;
        return this.updateEntry = createStatement(sql);
    },

    get updateEntryText() {
        var sql = 'UPDATE entries_text SET title = :title, content = :content, '+
                  'authors = :authors WHERE rowid = :id                        ';
        delete this.updateEntryText;
        return this.updateEntryText = createStatement(sql);
    },

    get getEntryByPrimaryHash() {
        var sql = 'SELECT id, date, read FROM entries WHERE primaryHash = :primaryHash';
        delete this.getEntryByPrimaryHash;
        return this.getEntryByPrimaryHash = createStatement(sql);
    },

    get getEntryBySecondaryHash() {
        var sql = 'SELECT id, date, read FROM entries WHERE secondaryHash = :secondaryHash';
        delete this.getEntryBySecondaryHash;
        return this.getEntryBySecondaryHash = createStatement(sql);
    },

    get selectEntriesByURL() {
        var sql = 'SELECT id, starred FROM entries WHERE entryURL = :url';
        delete this.selectEntriesByURL;
        return this.selectEntriesByURL = createStatement(sql);
    },

    get selectEntriesByBookmarkID() {
        var sql = 'SELECT id, starred, entryURL FROM entries WHERE bookmarkID = :bookmarkID';
        delete this.selectEntriesByBookmarkID;
        return this.selectEntriesByBookmarkID = createStatement(sql);
    },

    get selectEntriesByTagID() {
        var sql = 'SELECT id, entryURL FROM entries WHERE id IN (          '+
                  '    SELECT entryID FROM entry_tags WHERE tagID = :tagID '+
                  ')                                                       ';
        delete this.selectEntriesByTagID;
        return this.selectEntriesByTagID = createStatement(sql);
    },

    get starEntry() {
        var sql = 'UPDATE entries SET starred = 1, bookmarkID = :bookmarkID WHERE id = :entryID';
        delete this.starEntry;
        return this.starEntry = createStatement(sql);
    },

    get unstarEntry() {
        var sql = 'UPDATE entries SET starred = 0, bookmarkID = -1 WHERE id = :id';
        delete this.unstarEntry;
        return this.unstarEntry = createStatement(sql);
    },

    get tagEntry() {
        // XXX |OR IGNORE| is necessary, because some beta users mistakingly ended
        // up with tagID column marked as UNIQUE.
        var sql = 'INSERT OR IGNORE INTO entry_tags (entryID, tagName, tagID) '+
                  'VALUES (:entryID, :tagName, :tagID)            ';
        delete this.tagEntry;
        return this.tagEntry = createStatement(sql);
    },

    get untagEntry() {
        var sql = 'DELETE FROM entry_tags WHERE entryID = :entryID AND tagName = :tagName';
        delete this.untagEntry;
        return this.untagEntry = createStatement(sql);
    },

    get getTagsForEntry() {
        var sql = 'SELECT tagName FROM entry_tags WHERE entryID = :entryID';
        delete this.getTagsForEntry;
        return this.getTagsForEntry = createStatement(sql);
    },

    get getNameForTagID() {
        var sql = 'SELECT tagName FROM entry_tags WHERE tagID = :tagID LIMIT 1';
        delete this.getNameForTagID;
        return this.getNameForTagID = createStatement(sql);
    },

    get setSerializedTagList() {
        var sql = 'UPDATE entries_text SET tags = :tags WHERE rowid = :entryID';
        delete this.setSerializedTagList;
        return this.setSerializedTagList = createStatement(sql);
    },

    get selectStarredEntries() {
        var sql = 'SELECT entries.entryURL, entries.id, entries_text.title                 '+
                  'FROM entries INNER JOIN entries_text ON entries.id = entries_text.rowid '+
                  'WHERE starred = 1                                                       ';
        delete this.selectStarredEntries;
        return this.selectStarredEntries = createStatement(sql);
    }

}




/**
 * Synchronizes the list of feeds stored in the database with
 * the livemarks available in the Brief's home folder.
 */
function LivemarksSynchronizer() {
    if (!this.checkHomeFolder())
        return;

    this.newLivemarks = [];

    gConnection.beginTransaction();
    try {
        // Get the list of livemarks and folders in the home folder.
        this.getLivemarks();

        // Get the list of feeds stored in the database.
        this.getStoredFeeds();

        for each (livemark in this.foundLivemarks) {
            // Search for the bookmarked among the stored feeds.
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
        }

        for each (feed in this.storedFeeds) {
            if (!feed.bookmarked && feed.hidden == 0)
                this.hideFeed(feed);
        }
    }
    finally {
        gConnection.commitTransaction();
    }

    if (this.feedListChanged) {
        gStorageService.feedsCache = gStorageService.feedsAndFoldersCache = null;
        gObserverService.notifyObservers(null, 'brief:invalidate-feedlist', '');
    }

    // Update the newly added feeds.
    if (this.newLivemarks.length) {
        var feeds = [];
        for each (livemark in this.newLivemarks)
            feeds.push(gStorageService.getFeed(livemark.feedID));

        var updateService = Cc['@ancestor/brief/updateservice;1'].
                            getService(Ci.nsIBriefUpdateService);
        updateService.updateFeeds(feeds);
    }
}

LivemarksSynchronizer.prototype = {

    storedFeeds: null,
    newLivemarks: null,
    foundLivemarks: null,
    feedListChanged: false,

    checkHomeFolder: function BookmarksSync_checkHomeFolder() {
        var folderValid = true;
        var homeFolder = gPrefs.getIntPref('homeFolder');

        if (homeFolder == -1) {
            var hideAllFeeds = createStatement('UPDATE feeds SET hidden = :hidden');
            hideAllFeeds.params.hidden = Date.now();
            hideAllFeeds.execute();

            gStorageService.feedsCache = gStorageService.feedsAndFoldersCache = null;
            gObserverService.notifyObservers(null, 'brief:invalidate-feedlist', '');
            folderValid = false;
        }
        else {
            try {
                // This will throw if the home folder was deleted.
                gBms.getItemTitle(homeFolder);
            }
            catch (e) {
                gPrefs.clearUserPref('homeFolder');
                folderValid = false;
            }
        }

        return folderValid;
    },


    // Get the list of Live Bookmarks in the user's home folder.
    getLivemarks: function BookmarksSync_getLivemarks() {
        var homeFolder = gPrefs.getIntPref('homeFolder');
        this.foundLivemarks = [];

        var options = gPlaces.history.getNewQueryOptions();
        var query = gPlaces.history.getNewQuery();
        query.setFolders([homeFolder], 1);
        options.excludeItems = true;

        var result = gPlaces.history.executeQuery(query, options);
        this.traversePlacesQueryResults(result.root);
    },


    // Gets all feeds stored in the database.
    getStoredFeeds: function BookmarksSync_getStoredFeeds() {
        var selectAll = createStatement('SELECT feedID, title, rowIndex, isFolder,    ' +
                                        '       parent, bookmarkID, hidden FROM feeds ');

        this.storedFeeds = [];
        while (selectAll.step()) {
            var feed = {};
            feed.feedID = selectAll.row.feedID;
            feed.title = selectAll.row.title;
            feed.rowIndex = selectAll.row.rowIndex;
            feed.isFolder = (selectAll.row.isFolder == 1);
            feed.parent = selectAll.row.parent;
            feed.bookmarkID = selectAll.row.bookmarkID;
            feed.hidden = selectAll.row.hidden;
            this.storedFeeds.push(feed);
        }
    },


    insertFeed: function BookmarksSync_insertFeed(aBookmark) {
        var insert = createStatement(
            'INSERT OR IGNORE INTO feeds                                                   ' +
            '(feedID, feedURL, title, rowIndex, isFolder, parent, bookmarkID)              ' +
            'VALUES (:feedID, :feedURL, :title, :rowIndex, :isFolder, :parent, :bookmarkID)');

        insert.params.feedID = aBookmark.feedID;
        insert.params.feedURL = aBookmark.feedURL || null;
        insert.params.title = aBookmark.title;
        insert.params.rowIndex = aBookmark.rowIndex;
        insert.params.isFolder = aBookmark.isFolder ? 1 : 0;
        insert.params.parent = aBookmark.parent;
        insert.params.bookmarkID = aBookmark.bookmarkID;
        insert.execute();

        this.feedListChanged = true;
    },


    updateFeedFromLivemark: function BookmarksSync_updateFeedFromLivemark(aItem, aFeed) {
        if (aItem.rowIndex == aFeed.rowIndex && aItem.parent == aFeed.parent && aFeed.hidden == 0
            && aItem.title == aFeed.title && aItem.bookmarkID == aFeed.bookmarkID) {
            return;
        }

        var updateFeed = createStatement(
            'UPDATE feeds SET title = :title, rowIndex = :rowIndex, parent = :parent, ' +
            '                 bookmarkID = :bookmarkID, hidden = 0                    ' +
            'WHERE feedID = :feedID                                                   ');
        updateFeed.params.title = aItem.title;
        updateFeed.params.rowIndex = aItem.rowIndex;
        updateFeed.params.parent = aItem.parent;
        updateFeed.params.bookmarkID = aItem.bookmarkID;
        updateFeed.params.feedID = aItem.feedID;
        updateFeed.execute();

        if (aItem.rowIndex != aFeed.rowIndex || aItem.parent != aFeed.parent || aFeed.hidden > 0) {
            this.feedListChanged = true;
        }
        else {
            // Invalidate feeds cache.
            gStorageService.feedsCache = gStorageService.feedsAndFoldersCache = null;
            gObserverService.notifyObservers(null, 'brief:feed-title-changed', aItem.feedID);
        }
    },


    hideFeed: function BookmarksSync_hideFeed(aFeed) {
        if (aFeed.isFolder) {
            var removeFolder = createStatement('DELETE FROM feeds WHERE feedID = :feedID');
            removeFolder.params.feedID = aFeed.feedID;
            removeFolder.execute();
        }
        else {
            var hideFeed = createStatement('UPDATE feeds SET hidden = :hidden WHERE feedID = :feedID');
            hideFeed.params.hidden = Date.now();
            hideFeed.params.feedID = aFeed.feedID;
            hideFeed.execute();
        }

        this.feedListChanged = true;
    },


    traversePlacesQueryResults: function BookmarksSync_traversePlacesQueryResults(aContainer) {
        aContainer.containerOpen = true;

        for (var i = 0; i < aContainer.childCount; i++) {
            var node = aContainer.getChild(i);

            if (node.type != Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER)
                continue;

            item = {};
            item.title = gBms.getItemTitle(node.itemId);
            item.bookmarkID = node.itemId;
            item.rowIndex = this.foundLivemarks.length;
            item.parent = aContainer.itemId.toFixed().toString();

            if (isLivemark(node.itemId)) {
                var feedURL = gPlaces.livemarks.getFeedURI(node.itemId).spec;
                item.feedURL = feedURL;
                item.feedID = hashString(feedURL);
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


const ENTRY_STATE_NORMAL = Ci.nsIBriefQuery.ENTRY_STATE_NORMAL;
const ENTRY_STATE_TRASHED = Ci.nsIBriefQuery.ENTRY_STATE_TRASHED;
const ENTRY_STATE_DELETED = Ci.nsIBriefQuery.ENTRY_STATE_DELETED;
const ENTRY_STATE_ANY = Ci.nsIBriefQuery.ENTRY_STATE_ANY;


function BriefQuery() { }

BriefQuery.prototype = {

    entries: null,
    feeds:   null,
    folders: null,
    tags:    null,

    read:      false,
    unread:    false,
    starred:   false,
    unstarred: false,
    deleted:   ENTRY_STATE_ANY,

    searchString: '',

    startDate: 0,
    endDate:   0,

    limit:  0,
    offset: 1,

    sortOrder: Ci.nsIBriefQuery.NO_SORT,
    sortDirection: Ci.nsIBriefQuery.SORT_DESCENDING,

    includeHiddenFeeds: false,

    // When |nsIBriefQuery.folders| is set, it's not enough to take feeds from these
    // folders alone - we also have to consider their subfolders. Because feeds have
    // no knowledge about the folders they are in besides their direct parent, we have
    // to compute actual folders list when creating the query.
    effectiveFolders: null,

    // nsIBriefQuery
    setEntries: function BriefQuery_setEntries(aEntries) {
        this.entries = aEntries;
    },


    // nsIBriefQuery
    hasMatches: function BriefQuery_hasMatches() {
        try {
            var sql = 'SELECT EXISTS (SELECT entries.id ' + this.getQueryString(true) + ') AS found';
            var select = createStatement(sql);
            select.step();
            var exists = select.row.found;
        }
        catch (ex) {
            if (gConnection.lastError != 1) reportError(ex, true);
        }
        finally {
            select.reset();
        }

        return exists;
    },

    // nsIBriefQuery
    getEntries: function BriefQuery_getEntries() {
        try {
            var sql = 'SELECT entries.id ' + this.getQueryString(true);
            var select = createStatement(sql);
            var entries = [];
            while (select.step())
                entries.push(select.row.id);
        }
        catch (ex) {
            if (gConnection.lastError != 1) reportError(ex, true);
        }
        finally {
            select.reset();
        }

        return entries;
    },


    // nsIBriefQuery
    getFullEntries: function BriefQuery_getFullEntries() {
        var sql = 'SELECT entries.id, entries.feedID, entries.entryURL, entries.date,   '+
                  '       entries.read, entries.starred, entries.updated,               '+
                  '       entries.bookmarkID, entries_text.title, entries_text.content, '+
                  '       entries_text.authors, entries_text.tags                       ';
        sql += this.getQueryString(true, true);
        var select = createStatement(sql);

        var entries = [];
        try {
            while (select.step()) {
                var entry = Cc['@ancestor/brief/feedentry;1'].
                            createInstance(Ci.nsIBriefFeedEntry);

                entry.id = select.row.id;
                entry.feedID = select.row.feedID;
                entry.entryURL = select.row.entryURL;
                entry.date = select.row.date;
                entry.authors = select.row.authors;
                entry.read = select.row.read;
                entry.starred = select.row.starred;
                entry.updated = select.row.updated;
                entry.bookmarkID = select.row.bookmarkID;
                entry.title = select.row.title;
                entry.content = select.row.content;
                entry.tags = select.row.tags;

                entries.push(entry);
            }
        }
        catch (ex) {
            // Ignore "SQL logic error or missing database" error which full-text search
            // throws when the query doesn't contain at least one non-excluded term.
            if (gConnection.lastError != 1) reportError(ex, true);
        }
        finally {
            select.reset();
        }

        return entries;
    },


    // nsIBriefQuery
    getProperty: function BriefQuery_getProperty(aPropertyName, aDistinct) {
        var rows = [];
        var values = [];

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

        try {
            var select = createStatement('SELECT entries.id, ' + table + aPropertyName +
                                         this.getQueryString(true, getEntriesText));

            while (select.step()) {
                let propertyValue = select.row[aPropertyName];
                if (aDistinct && values.indexOf(propertyValue) != -1)
                    continue;

                values.push(propertyValue);

                let row = { };
                row[aPropertyName] = propertyValue;
                row.ID = select.row.id;
                rows.push(row);
            }
        }
        catch (ex) {
            if (gConnection.lastError != 1) reportError(ex, true);
        }
        finally {
            select.reset();
        }

        return rows;
    },


    // nsIBriefQuery
    getEntryCount: function BriefQuery_getEntryCount() {
        // Optimization: ignore sorting settings.
        var tempOrder = this.sortOrder;
        this.sortOrder = Ci.nsIBriefQuery.NO_SORT;
        var select = createStatement('SELECT COUNT(1) AS count ' + this.getQueryString(true));
        this.sortOrder = tempOrder;

        try {
            select.step();
            var count = select.row.count;
        }
        catch (ex) {
            if (gConnection.lastError != 1) reportError(ex, true);
        }
        finally {
            select.reset();
        }

        return count;
    },


    /**
     * Used to get nsIBriefEntryList of changed entries, so that it can be passed to
     * nsIBriefStorageObserver's.
     */
    getEntryList: function BriefQuery_getEntryList() {
        try {
            var entryIDs = [];
            var feedIDs = [];
            var tags = [];

            var tempHidden = this.includeHiddenFeeds;
            this.includeHiddenFeeds = false;

            var sql = 'SELECT entries.id, entries.feedID, entries_text.tags ';
            var select = createStatement(sql + this.getQueryString(true, true));
            while (select.step()) {
                entryIDs.push(select.row.id);

                let feedID = select.row.feedID;
                if (feedIDs.indexOf(feedID) == -1)
                    feedIDs.push(feedID);

                let tagSet = select.row.tags;
                if (tagSet) {
                    tagSet = tagSet.split(', ');
                    for (let i = 0; i < tagSet.length; i++) {
                        if (tags.indexOf(tagSet[i]) == -1)
                            tags.push(tagSet[i]);
                    }
                }
            }
        }
        catch (ex) {
            if (gConnection.lastError != 1) reportError(ex, true);
        }
        finally {
            select.reset();
            this.includeHiddenFeeds = tempHidden;
        }

        var list = Cc['@ancestor/brief/entrylist;1'].
                   createInstance(Ci.nsIBriefEntryList);
        list.IDs = entryIDs;
        list.feedIDs = feedIDs;
        list.tags = tags;

        return list;
    },


    // nsIBriefQuery
    markEntriesRead: function BriefQuery_markEntriesRead(aState) {
        // We try not to include entries which already have the desired state,
        // but we can't omit them if a specific range of the selected entries
        // is meant to be marked.
        var tempRead = this.read;
        var tempUnread = this.unread;
        if (!this.limit && this.offset === 1) {
            this.read = !aState;
            this.unread = aState;
        }

        var update = createStatement('UPDATE entries SET read = :read, updated = 0 ' +
                                     this.getQueryString())
        update.params.read = aState ? 1 : 0;

        gConnection.beginTransaction();
        try {
            var list = this.getEntryList();
            update.execute();
        }
        catch (ex) {
            if (gConnection.lastError != 1) reportError(ex, true);
        }
        finally {
            this.unread = tempUnread;
            this.read = tempRead;

            gConnection.commitTransaction();
        }

        if (list.length) {
            for each (observer in gStorageService.observers)
                observer.onEntriesMarkedRead(list, aState);
        }
    },


    // nsIBriefQuery
    deleteEntries: function BriefQuery_deleteEntries(aState) {
        switch (aState) {
            case ENTRY_STATE_NORMAL:
            case ENTRY_STATE_TRASHED:
            case ENTRY_STATE_DELETED:
                var statement = createStatement('UPDATE entries SET deleted = ' +aState+
                                                 this.getQueryString());
                break;
            case Ci.nsIBriefQuery.REMOVE_FROM_DATABASE:
                var statement = createStatement('DELETE FROM entries ' + this.getQueryString());
                break;
            default:
                throw Components.results.NS_ERROR_INVALID_ARG;
        }

        gConnection.beginTransaction();
        try {
            var list = this.getEntryList();
            statement.execute();
        }
        catch (ex) {
            if (gConnection.lastError != 1) reportError(ex, true);
        }
        finally {
            gConnection.commitTransaction();
        }

        if (list.length) {
            for each (observer in gStorageService.observers)
                observer.onEntriesDeleted(list, aState);
        }
    },


    /**
     * nsIBriefQuery
     *
     * This function bookmarks URIs of the selected entries. It doesn't star the entries
     * in the database or send notifications - that part performed by the bookmarks
     * observer implemented by BriefStorageService.
     */
    starEntries: function BriefQuery_starEntries(aState) {
        var transSrv = Cc['@mozilla.org/browser/placesTransactionsService;1'].
                       getService(Ci.nsIPlacesTransactionsService);
        var folder = gPlaces.unfiledBookmarksFolderId;
        var transactions = []

        for each (entry in this.getFullEntries()) {
            let uri = newURI(entry.entryURL);

            if (aState) {
                let trans = transSrv.createItem(uri, folder, gBms.DEFAULT_INDEX,
                                                entry.title);
                transactions.push(trans);
            }
            else {
                let bookmarks = gBms.getBookmarkIdsForURI(uri, {}).
                                     filter(isNormalBookmark);
                if (bookmarks.length) {
                    for (let i = bookmarks.length - 1; i >= 0; i--) {
                        let trans = transSrv.removeItem(bookmarks[i]);
                        transactions.push(trans);
                    }
                }
                else {
                    // If there are no bookmarks for an URL that is starred in our
                    // database, it means that the database is out of sync. We've
                    // got to update the database directly instead of relying on
                    // the bookmarks observer implemented by BriefStorageService.
                    gStorageService.starEntry(false, entry.id);
                    gStorageService.notifyOfEntriesStarred([entry.id], false);
                }
            }
        }

        var aggregatedTrans = transSrv.aggregateTransactions('', transactions);
        transSrv.doTransaction(aggregatedTrans);
    },

    // nsIBriefQuery
    verifyEntriesStarredStatus: function BriefQuery_verifyEntriesStarredStatus() {
        var statusOK = true;

        for each (entry in this.getFullEntries()) {
            let uri = newURI(entry.entryURL);
            let bookmarks = gBms.getBookmarkIdsForURI(uri, {});
            let normalBookmarks = bookmarks.filter(isNormalBookmark)

            if (!entry.starred || entry.starred && !normalBookmarks.length) {
                let query = new BriefQuery();
                query.entries = [entry.id];
                query.starEntries(true);
                statusOK = false;
            }

            let addedTags, removedTags;
            [addedTags, removedTags] = gStorageService.refreshTagsForEntry(entry.id, bookmarks);

            for each (tag in addedTags)
                gStorageService.notifyOfEntriesTagged([entry.id], true, tag);
            for each (tag in removedTags)
                gStorageService.notifyOfEntriesTagged([entry.id], false, tag);

            statusOK = !addedTags.length && !removedTags.length;
        }

        return statusOK;
    },

    /**
     * Constructs SQL query constraints based on attributes of this nsIBriefQuery object.
     *
     * @param aForSelect      Build a string optimized for a SELECT statement.
     * @param aGetFullEntries Forces including entries_text table (otherwise, it is
     *                        included only when it is used by the query constraints).
     * @returns String containing the part of an SQL statement after WHERE clause.
     */
    getQueryString: function BriefQuery_getQueryString(aForSelect, aGetFullEntries) {
        var nsIBriefQuery = Components.interfaces.nsIBriefQuery;

        var text = aForSelect ? ' FROM entries '
                              : ' WHERE entries.id IN (SELECT entries.id FROM entries ';

        if (this.feeds || !this.feeds && !this.includeHiddenFeeds)
            text += ' INNER JOIN feeds ON entries.feedID = feeds.feedID ';

        if (aGetFullEntries || this.searchString || this.sortOrder == nsIBriefQuery.SORT_BY_TITLE)
            text += ' INNER JOIN entries_text ON entries.id = entries_text.rowid ';

        if (this.tags)
            text += ' INNER JOIN entry_tags ON entries.id = entry_tags.entryID ';

        var constraints = [];

        if (this.folders && this.folders.length) {
            // Fill the list of effective folders.
            this.effectiveFolders = this.folders;
            this.traverseFolderChildren(gStorageService.homeFolderID);

            let con = '(feeds.parent = "';
            con += this.effectiveFolders.join('" OR feeds.parent = "');
            con += '")';
            constraints.push(con);
        }

        if (this.feeds && this.feeds.length) {
            let con = '(entries.feedID = "';
            con += this.feeds.join('" OR entries.feedID = "');
            con += '")';
            constraints.push(con);
        }

        if (this.entries && this.entries.length) {
            let con = '(entries.id = ';
            con += this.entries.join(' OR entries.id = ');
            con += ')';
            constraints.push(con);
        }

        if (this.tags && this.tags.length) {
            let con = '(entry_tags.tagName = "';
            con += this.tags.join('" OR entry_tags.tagName = "');
            con += '")';
            constraints.push(con);
        }

        if (this.searchString) {
            let con = 'entries_text MATCH \'' + this.searchString.replace("'",' ') + '\'';
            constraints.push(con);
        }

        if (this.read)
            constraints.push('entries.read = 1');
        if (this.unread)
            constraints.push('entries.read = 0');
        if (this.starred)
            constraints.push('entries.starred = 1');
        if (this.unstarred)
            constraints.push('entries.starred = 0');

        if (this.deleted != ENTRY_STATE_ANY)
            constraints.push('entries.deleted = ' + this.deleted);

        if (this.startDate > 0)
            constraints.push('entries.date >= ' + this.startDate);
        if (this.endDate > 0)
            constraints.push('entries.date <= ' + this.endDate);

        if (!this.includeHiddenFeeds && !this.feeds)
            constraints.push('feeds.hidden = 0');

        if (constraints.length)
            text += ' WHERE ' + constraints.join(' AND ') + ' ';

        if (this.sortOrder != nsIBriefQuery.NO_SORT) {
            switch (this.sortOrder) {
                case nsIBriefQuery.SORT_BY_FEED_ROW_INDEX:
                    var sortOrder = 'feeds.rowIndex ';
                    break;
                case nsIBriefQuery.SORT_BY_DATE:
                    sortOrder = 'entries.date ';
                    break;
                case nsIBriefQuery.SORT_BY_TITLE:
                    sortOrder = 'entries_text.title ';
                    break;
                default:
                    throw Components.results.NS_ERROR_ILLEGAL_VALUE;
            }

            var sortDir = (this.sortDirection == nsIBriefQuery.SORT_ASCENDING) ? 'ASC' : 'DESC';
            text += 'ORDER BY ' + sortOrder + sortDir;
        }

        if (this.limit)
            text += ' LIMIT ' + this.limit;
        if (this.offset > 1)
            text += ' OFFSET ' + this.offset;

        if (!aForSelect)
            text += ') ';

        return text;
    },

    traverseFolderChildren: function BriefQuery_traverseFolderChildren(aFolder) {
        var isEffectiveFolder = (this.effectiveFolders.indexOf(aFolder) != -1);
        var items = gStorageService.getAllFeeds(true);

        for (var i = 0; i < items.length; i++) {
            if (items[i].parent == aFolder && items[i].isFolder) {
                if (isEffectiveFolder)
                    this.effectiveFolders.push(items[i].feedID);
                this.traverseFolderChildren(items[i].feedID);
            }
        }
    },


    classDescription: 'Query to database of the Brief extension',
    classID: Components.ID('{10992573-5d6d-477f-8b13-8b578ad1c95e}'),
    contractID: '@ancestor/brief/query;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIBriefQuery])
}



// ---------------- Utility functions -----------------

function newURI(aSpec) {
    return Cc['@mozilla.org/network/io-service;1'].
           getService(Ci.nsIIOService).
           newURI(aSpec, null, null);
}

function isBookmark(aItemID) {
    return (gBms.getItemType(aItemID) === gBms.TYPE_BOOKMARK);
}

function isNormalBookmark(aItemID) {
    let parent = gBms.getFolderIdForItem(aItemID);
    return !isLivemark(parent) && !isTagFolder(parent);
}

function isLivemark(aItemID) {
    return gPlaces.livemarks.isLivemark(aItemID);
}

function isFolder(aItemID) {
    return (gBms.getItemType(aItemID) === gBms.TYPE_FOLDER);
}

function isTagFolder(aItemID) {
    return (gBms.getFolderIdForItem(aItemID) === gPlaces.tagsFolderId);
}

// Returns TRUE if an item is a subfolder of Brief's home folder.
function isInHomeFolder(aItemID) {
    var homeID = gStorageService.homeFolderID;
    if (homeID === -1)
        return false;

    if (homeID === aItemID)
        return true;

    var inHome = false;
    var parent = aItemID;
    while (parent !== gPlaces.placesRootId) {
        parent = gBms.getFolderIdForItem(parent);
        if (parent === homeID) {
            inHome = true;
            break;
        }
    }

    return inHome;
}


function hashString(aString) {
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


function reportError(aException, aRethrow) {
    var message = aException.message;
    message += ' Stack: ' + aException.stack;
    message += ' Database error: ' + gConnection.lastErrorString;
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


var components = [BriefStorageService, BriefQuery];
function NSGetModule(compMgr, fileSpec) XPCOMUtils.generateModule(components)
