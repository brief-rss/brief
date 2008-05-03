const STORAGE_CLASS_ID = Components.ID('{4C468DA8-7F30-11DB-A690-EBF455D89593}');
const STORAGE_CLASS_NAME = 'mozStorage database component for the Brief extension';
const STORAGE_CONTRACT_ID = '@ancestor/brief/storage;1';

const QUERY_CLASS_ID = Components.ID('{10992573-5d6d-477f-8b13-8b578ad1c95e}');
const QUERY_CLASS_NAME = 'Query to database of the Brief extension';
const QUERY_CONTRACT_ID = '@ancestor/brief/query;1';

var Cc = Components.classes;
var Ci = Components.interfaces;

const ENTRY_STATE_NORMAL = Ci.nsIBriefQuery.ENTRY_STATE_NORMAL;
const ENTRY_STATE_TRASHED = Ci.nsIBriefQuery.ENTRY_STATE_TRASHED;
const ENTRY_STATE_DELETED = Ci.nsIBriefQuery.ENTRY_STATE_DELETED;

// How often to perform entry expiration and remove the deleted items.
const PURGE_ENTRIES_INTERVAL = 3600*24; // 1 day

// How long to keep entries from feeds which are no longer in the home folder.
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // 1 week

const BOOKMARKS_OBSERVER_DELAY = 250;

const DATABASE_VERSION = 7;
const FEEDS_TABLE_SCHEMA = 'feedID          TEXT UNIQUE,         ' +
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
                           'dateModified    INTEGER DEFAULT 0    ';
const ENTRIES_TABLE_SCHEMA = 'id          TEXT UNIQUE,        ' +
                             'feedID      TEXT,               ' +
                             'secondaryID TEXT,               ' +
                             'providedID  TEXT,               ' +
                             'entryURL    TEXT,               ' +
                             'date        INTEGER,            ' +
                             'authors     TEXT,               ' +
                             'read        INTEGER DEFAULT 0,  ' +
                             'updated     INTEGER DEFAULT 0,  ' +
                             'starred     INTEGER DEFAULT 0,  ' +
                             'deleted     INTEGER DEFAULT 0,  ' +
                             'bookmarkID  INTEGER DEFAULT -1  ';
const ENTRIES_TEXT_TABLE_SCHEMA = 'title, content';


Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/utils.js');

var gPlaces = PlacesUtils;

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
__defineGetter__('gStringbundle', function() {
    delete this.gStringbundle;
    return this.gStringbundle = Cc['@mozilla.org/intl/stringbundle;1'].
                                getService(Ci.nsIStringBundleService).
                                createBundle('chrome://brief/locale/brief.properties');
});


function executeSQL(aSQLString) {
    gConnection.executeSimpleSQL(aSQLString);
}

function createStatement(aSQLString) {
    var statement = gConnection.createStatement(aSQLString);
    var wrapper = Cc['@mozilla.org/storage/statement-wrapper;1'].
                  createInstance(Ci.mozIStorageStatementWrapper);
    wrapper.initialize(statement)
    return wrapper;
}


var gStorageService = null;
var gConnection = null;

function BriefStorageService() {
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

        if (!gConnection.connectionReady) {
            storageService.backupDatabaseFile(databaseFile, 'brief-backup.sqlite');
            gConnection.close();
            databaseFile.remove(false);
            gConnection = storageService.openUnsharedDatabase(databaseFile);
            this.setupDatabase();
        }
        else if (databaseIsNew) {
            this.setupDatabase();
        }
        else if (gConnection.schemaVersion < DATABASE_VERSION) {
            // Remove the old backup file.
            var filename = 'brief-backup' + (DATABASE_VERSION - 1) + '.sqlite';
            var oldBackupFile = profileDir.clone();
            oldBackupFile.append(filename);
            if (oldBackupFile.exists())
                oldBackupFile.remove(false);

            // Backup the database before migration.
            filename = 'brief-backup' + DATABASE_VERSION + '.sqlite';
            var newBackupFile = profileDir;
            newBackupFile.append(filename);
            if (!newBackupFile.exists())
                storageService.backupDatabaseFile(databaseFile, filename);

            this.migrateDatabase();
        }

        this.homeFolderID = gPrefs.getIntPref('homeFolder');
        gPrefs.addObserver('', this, false);
        gPlaces.bookmarks.addObserver(this, false);
        gObserverService.addObserver(this, 'quit-application', false);
    },

    setupDatabase: function BriefStorage_setupDatabase() {
        //executeSQL('DROP TABLE IF EXISTS feeds');
        //executeSQL('DROP TABLE IF EXISTS entries');

        executeSQL('CREATE TABLE IF NOT EXISTS feeds (' + FEEDS_TABLE_SCHEMA + ')');
        executeSQL('CREATE TABLE IF NOT EXISTS entries (' + ENTRIES_TABLE_SCHEMA + ')');
        executeSQL('CREATE VIRTUAL TABLE entries_text using fts3(' + ENTRIES_TEXT_TABLE_SCHEMA + ')');

        executeSQL('CREATE INDEX IF NOT EXISTS entries_feedID_index ON entries (feedID) ');
        executeSQL('CREATE INDEX IF NOT EXISTS entries_date_index ON entries (date)     ');

        gConnection.schemaVersion = DATABASE_VERSION;
    },


    migrateDatabase: function BriefStorage_migrateDatabase() {
        switch (gConnection.schemaVersion) {

        // Schema version checking has only been introduced in 0.8 beta 1. When migrating
        // from earlier releases we don't know the exact previous version, so we attempt
        // to apply all the changes since the beginning of time.
        case 0:
            // Columns added in 0.6.
            try {
                executeSQL('ALTER TABLE feeds ADD COLUMN oldestAvailableEntryDate INTEGER');
                executeSQL('ALTER TABLE entries ADD COLUMN providedID TEXT');
            }
            catch (ex) { }

            // Columns and indices added in 0.7.
            try {
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

            // Abandon the summary column and always store the prefered data
            // in the content column.
            var updateEntryContent = createStatement(
                'UPDATE entries SET content = summary, summary = "" WHERE content = ""');
            updateEntryContent.execute();
            // Fall through...

        // To 1.0 beta 1
        case 2:
            // Due to a bug, the next step threw an exception in 1.0 and 1.0.1 for some
            // users, which caused the below column to be added but the new user_version
            // wasn't set. We have to catch an the exception caused by attempting to add
            // an existing column to allow the migration to be completed for those users.
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
            this.recreateFeedsTable();
            this.recomputeIDs();
            executeSQL('ALTER TABLE entries ADD COLUMN bookmarkID INTEGER DEFAULT -1');
            this.bookmarkStarredEntries();
            // Fall through...

        // To 1.2a2
        case 5:
            this.migrateEntriesToFTS();
            // Fall through...

        // To 1.2b2
        case 6:
            executeSQL('ALTER TABLE feeds ADD COLUMN markModifiedEntriesUnread INTEGER DEFAULT 1');

        }

        gConnection.schemaVersion = DATABASE_VERSION;
    },


    recreateFeedsTable: function BriefStorage_recreateFeedsTable() {
        // Columns in this list must be in the same order as the respective columns
        // in the new schema.
        const OLD_COLUMNS = 'feedID, feedURL, websiteURL, title, subtitle, imageURL,    ' +
                            'imageLink, imageTitle, favicon, RDF_URI, rowIndex, parent, ' +
                            'isFolder, hidden, lastUpdated, oldestAvailableEntryDate,   ' +
                            'entryAgeLimit, maxEntries, updateInterval, dateModified    ';

        gConnection.beginTransaction();
        try {
            executeSQL('ALTER TABLE feeds ADD COLUMN dateModified INTEGER DEFAULT 0');

            executeSQL('CREATE TABLE feeds_copy (' + OLD_COLUMNS + ')');
            executeSQL('INSERT INTO feeds_copy SELECT ' + OLD_COLUMNS + ' FROM feeds');
            executeSQL('DROP TABLE feeds');
            executeSQL('CREATE TABLE feeds (' + FEEDS_TABLE_SCHEMA + ')');
            executeSQL('INSERT INTO feeds SELECT * FROM feeds_copy');
            executeSQL('DROP TABLE feeds_copy');
        }
        catch (ex) {
            reportError(ex, true);
        }
        finally {
            gConnection.commitTransaction();
        }
    },


    migrateEntriesToFTS: function BriefStorage_migrateEntriesToFTS() {
        const OLD_COLUMNS = 'id, feedID, secondaryID , providedID, entryURL, title, content, ' +
                            'date, authors, read, updated, starred, deleted, bookmarkID      ';
        const NEW_COLUMNS = 'id, feedID, secondaryID , providedID, entryURL, date, ' +
                            'authors, read, updated, starred, deleted, bookmarkID  ';

        gConnection.beginTransaction();
        try {
            executeSQL('CREATE TABLE entries_copy (' + OLD_COLUMNS + ')');
            executeSQL('INSERT INTO entries_copy SELECT ' + OLD_COLUMNS + ' FROM entries');
            executeSQL('DROP TABLE entries');

            // This will recreate the entries table and its indices.
            executeSQL('CREATE TABLE IF NOT EXISTS entries (' + ENTRIES_TABLE_SCHEMA + ')');
            executeSQL('CREATE VIRTUAL TABLE entries_text using fts3(' + ENTRIES_TEXT_TABLE_SCHEMA + ')');
            executeSQL('CREATE INDEX IF NOT EXISTS entries_feedID_index ON entries (feedID) ');
            executeSQL('CREATE INDEX IF NOT EXISTS entries_date_index ON entries (date)     ');

            executeSQL('INSERT INTO entries (rowid, ' + NEW_COLUMNS + ')' +
                       'SELECT rowid, ' + NEW_COLUMNS + ' FROM entries_copy ');
            executeSQL('INSERT INTO entries_text (title, content) ' +
                       'SELECT title, content FROM entries_copy   ');
            executeSQL('DROP TABLE entries_copy');
        }
        catch (ex) {
            reportError(ex, true);
        }
        finally {
            gConnection.commitTransaction();
        }
    },


    bookmarkStarredEntries: function BriefStorage_bookmarkStarredEntries() {
        var ioService = Cc['@mozilla.org/network/io-service;1'].
                        getService(Ci.nsIIOService);
        var unfiledFolder = gPlaces.unfiledBookmarksFolderId;
        var tagName = gStringbundle.GetStringFromName('bookmarkedEntryTagName');
        var bookmarkedEntries = [];

        var select = createStatement(
            'SELECT entries.entryURL, entries.id, entries_text.title                    ' +
            'FROM entries INNER JOIN entries_text ON entries.rowid = entries_text.rowid ' +
            'WHERE starred = 1                                                          ');
        var update = createStatement('UPDATE entries SET bookmarkID = :bookmarkID ' +
                                     'WHERE id = :entryID                         ');

        gConnection.beginTransaction();
        try {
            while (select.step()) {
                var uri = ioService.newURI(select.row.entryURL, null, null);
                var title = select.row.title;
                var entryID = select.row.id;

                var bookmarkID = gPlaces.bookmarks.insertBookmark(unfiledFolder, uri,
                                                                  -1, title);
                gPlaces.tagging.tagURI(uri, [tagName]);

                update.params.bookmarkID = bookmarkID;
                update.params.entryID = entryID;
                update.execute();
            }
        }
        catch (ex) {
            reportError(ex, true);
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
                       '   WHERE entries.date >= feeds.oldestEntryDate AND                ' +
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
        var feeds = this.getAllFeedsAndFolders();
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
        var feeds = this.getAllFeedsAndFolders();
        for (var i = 0; i < feeds.length; i++) {
            if (feeds[i].bookmarkID == aBookmarkID) {
                foundFeed = feeds[i];
                break;
            }
        }
        return foundFeed;
    },


    // nsIBriefStorage
    getAllFeeds: function BriefStorage_getAllFeeds() {
        if (!this.feedsCache)
            this.buildFeedsCache();

        return this.feedsCache;
    },


    // nsIBriefStorage
    getAllFeedsAndFolders: function BriefStorage_getAllFeedsAndFolders() {
        if (!this.feedsAndFoldersCache)
            this.buildFeedsCache();

        return this.feedsAndFoldersCache;
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
    updateFeed: function BriefStorage_updateFeed(aFeed) {
        var newEntriesCount = 0;
        var dateModified = new Date(aFeed.wrappedFeed.updated).getTime();

        if (!dateModified || dateModified > this.getFeed(aFeed.feedID).dateModified) {
            aFeed.oldestEntryDate = Date.now();
            var entries = aFeed.entries;

            gConnection.beginTransaction();
            try {
                for (let i = 0; i < entries.length; i++) {
                    if (this.processEntry(entries[i], aFeed))
                        newEntriesCount++;

                    if (entries[i].date && entries[i].date < aFeed.oldestEntryDate)
                        aFeed.oldestEntryDate = entries[i].date;
                }

                let stmt = this.updateFeed_stmt;
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
        subject.setAsInt32(newEntriesCount);
        gObserverService.notifyObservers(subject, 'brief:feed-updated', aFeed.feedID);
    },

    get updateFeed_stmt BriefStorage_updateFeed_stmt() {
        delete this.__proto__.updateFeed_stmt;
        return this.__proto__.updateFeed_stmt = createStatement(
               'UPDATE feeds                            ' +
               'SET websiteURL = :websiteURL,           ' +
               '    subtitle   = :subtitle,             ' +
               '    imageURL   = :imageURL,             ' +
               '    imageLink  = :imageLink,            ' +
               '    imageTitle = :imageTitle,           ' +
               '    favicon    = :favicon,              ' +
               '    oldestEntryDate = :oldestEntryDate, ' +
               '    lastUpdated  = :lastUpdated,        ' +
               '    dateModified = :dateModified        ' +
               'WHERE feedID = :feedID                  ');
    },

    get insertEntry_stmt BriefStorage_insertEntry_stmt() {
        delete this.__proto__.insertEntry_stmt;
        return this.__proto__.insertEntry_stmt = createStatement(
        'INSERT INTO entries (feedID, id, secondaryID, providedID, entryURL, date, authors) ' +
        'VALUES (:feedID, :id, :secondaryID, :providedID, :entryURL, :date, :authors)       ');
    },

    get insertEntryText_stmt BriefStorage_insertEntryText_stmt() {
        delete this.__proto__.insertEntryText_stmt;
        return this.__proto__.insertEntryText_stmt = createStatement(
               'INSERT INTO entries_text (rowid, title, content) ' +
               'VALUES(last_insert_rowid(), :title, :content)    ');
    },

    get updateEntry_stmt BriefStorage_updateEntry_stmt() {
        delete this.__proto__.updateEntry_stmt;
        return this.__proto__.updateEntry_stmt = createStatement(
               'UPDATE entries                                                   ' +
               'SET date = :date, authors = :authors, read = :read, updated = 1  ' +
               'WHERE id = :id                                                   ');
    },

    get updateEntryText_stmt BriefStorage_updateEntryText_stmt() {
        delete this.__proto__.updateEntryText_stmt;
        return this.__proto__.updateEntryText_stmt = createStatement(
               'UPDATE entries_text                                      ' +
               'SET title = :title, content = :content                   ' +
               'WHERE rowid = (SELECT rowid FROM entries WHERE id = :id) ');
    },

    get checkByPrimaryID_stmt BriefStorage_checkByPrimaryID_stmt() {
        delete this.__proto__.checkByPrimaryID_stmt;
        return this.__proto__.checkByPrimaryID_stmt = createStatement(
               'SELECT date FROM entries WHERE id = :id');
    },

    get checkBySecondaryID_stmt BriefStorage_checkBySecondaryID_stmt() {
        delete this.__proto__.checkBySecondaryID_stmt;
        return this.__proto__.checkBySecondaryID_stmt = createStatement(
               'SELECT date FROM entries WHERE secondaryID = :secondaryID');
    },


    processEntry: function BriefStorage_processEntry(aEntry, aFeed) {
        var content = aEntry.content || aEntry.summary;

        // Strip tags
        var title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : '';

        // We have two types of IDs: primary and secondary. The former is used as a
        // unique identifier at all times, while the latter is only used during updating,
        // to work around a bug (see later). Below there are two sets of fields used to
        // produce each of the hashes.
        var primarySet = aEntry.id ? [aFeed.feedID, aEntry.id]
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

        var primaryID = hashString(primarySet.join(''));
        var secondaryID = hashString(secondarySet.join(''));

        // Sometimes the provided GUID is lost (maybe a bug in the parser?) and
        // having an empty GUID effects in a different hash, which leads to
        // annoying duplication of entries. In such case, we work around it by
        // checking for entry's existance using the secondary hash, which doesn't
        // include the GUID and is therefore immune to that problem.
        //
        // While checking, we also get the date which we'll need to see if the
        // stored entry needs to be updated.
        if (!aEntry.id) {
            var check = this.checkBySecondaryID_stmt;
            check.params.secondaryID = secondaryID;
        }
        else {
            check = this.checkByPrimaryID_stmt;
            check.params.id = primaryID;
        }
        var entryAlreadyStored = check.step();
        var storedEntryDate = entryAlreadyStored ? check.row.date : 0;;
        check.reset();

        var entryInserted = false;

        // If the entry is already present in the database, compare if the downloaded
        // entry has a newer date than the stored one and if so, update it.
        // Otherwise, insert it if it isn't present yet.
        if (entryAlreadyStored) {
            if (aEntry.date && storedEntryDate < aEntry.date) {
                let markUnread = this.getFeed(aFeed.feedID).markModifiedEntriesUnread;
                var update = this.updateEntry_stmt;
                update.params.date = aEntry.date;
                update.params.authors = aEntry.authors;
                update.params.read = markUnread ? 0 : 1;
                update.params.id = primaryID;
                update.execute();

                update = this.updateEntryText_stmt;
                update.params.title = aEntry.title;
                update.params.content = content;
                update.params.id = primaryID;
                update.execute();

                entryInserted = true;
            }
        }
        else {
            var insert = this.insertEntry_stmt;
            insert.params.feedID = aFeed.feedID;
            insert.params.id = primaryID;
            insert.params.secondaryID = secondaryID;
            insert.params.providedID = aEntry.id;
            insert.params.entryURL = aEntry.entryURL;
            insert.params.date = aEntry.date || Date.now();
            insert.params.authors = aEntry.authors;
            insert.execute();

            insert = this.insertEntryText_stmt;
            insert.params.title = aEntry.title;
            insert.params.content = content;
            insert.execute();

            entryInserted = true;
        }

        return entryInserted;
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
                this.instantiate();
                break;

            case 'quit-application':
                // Integer prefs are longs while Date is a long long.
                var now = Math.round(Date.now() / 1000);
                var lastPurgeTime = gPrefs.getIntPref('database.lastPurgeTime');
                if (now - lastPurgeTime > PURGE_ENTRIES_INTERVAL)
                    this.purgeEntries(true);

                gPlaces.bookmarks.removeObserver(this);
                gPrefs.removeObserver('', this);
                gObserverService.removeObserver(this, 'quit-application');
                gObserverService.removeObserver(this, 'profile-after-change');

                this.bookmarksObserverDelayTimer = null;
                break;

            case 'timer-callback':
                this.bookmarksObserverTimerIsRunning = false;
                this.syncWithBookmarks();
                break;

            case 'nsPref:changed':
                switch (aData) {
                    case 'homeFolder':
                        this.homeFolderID = gPrefs.getIntPref('homeFolder');
                        this.syncWithBookmarks();
                        break;
                }
                break;
        }
    },


    // nsIBriefStorage
    syncWithBookmarks: function BriefStorage_syncWithBookmarks() {
        new BookmarksSynchronizer();
    },


    homeFolderID: -1,

    // State properties uses by the bookmarks observer.
    batchUpdateInProgress: false,
    homeFolderContentModified: false,
    bookmarksObserverTimerIsRunning: false,

    __bookmarksObserverDelayTimer: null,
    get bookmarksObserverDelayTimer BriefStorage_bookmarksObserverDelayTimer() {
        if (!this.__bookmarksObserverDelayTimer) {
            this.__bookmarksObserverDelayTimer = Cc['@mozilla.org/timer;1'].
                                                 createInstance(Ci.nsITimer);
        }
        return this.__bookmarksObserverDelayTimer;
    },


    // nsINavBookmarkObserver
    onEndUpdateBatch: function BriefStorage_onEndUpdateBatch() {
        if (this.homeFolderContentModified)
            this.delayedBookmarksSync();

        this.batchUpdateInProgress = false;
        this.homeFolderContentModified = false;
    },

    // nsINavBookmarkObserver
    onBeginUpdateBatch: function BriefStorage_onBeginUpdateBatch() {
        this.batchUpdateInProgress = true;
    },

    // nsINavBookmarkObserver
    onItemAdded: function BriefStorage_onItemAdded(aItemID, aFolder, aIndex) {
        if (this.isItemFolder(aItemID) && this.isItemInHomeFolder(aItemID)) {
            if (this.batchUpdateInProgress)
                this.homeFolderContentModified = true;
            else
                this.delayedBookmarksSync();
        }
    },

    // nsINavBookmarkObserver
    onItemRemoved: function BriefStorage_onItemRemoved(aItemID, aFolder, aIndex) {
        if (this.isItemStoredInDB(aItemID) || aItemID == this.homeFolderID) {
            if (this.batchUpdateInProgress)
                this.homeFolderContentModified = true;
            else
                this.delayedBookmarksSync();
        }
    },

    // nsINavBookmarkObserver
    onItemMoved: function BriefStorage_onItemMoved(aItemID, aOldParent, aOldIndex,
                                                   aNewParent, aNewIndex) {
        if (this.isItemStoredInDB(aItemID) || this.isItemInHomeFolder(aItemID)) {
            if (this.batchUpdateInProgress)
                this.homeFolderContentModified = true;
            else
                this.delayedBookmarksSync();
        }
    },

    // nsINavBookmarkObserver
    onItemChanged: function BriefStorage_onItemChanged(aItemID, aProperty,
                                                       aIsAnnotationProperty, aValue) {
        var feed = this.getFeedByBookmarkID(aItemID);
        if (!feed)
            return;

        switch (aProperty) {
        case 'title':
            var update = createStatement('UPDATE feeds SET title = :title WHERE feedID = :feedID');
            update.params.title = aValue;
            update.params.feedID = feed.feedID;
            update.execute();

            feed.title = aValue; // Update the cached item.

            gObserverService.notifyObservers(null, 'brief:feed-title-changed', feed.feedID);
            break;

        case 'livemark/feedURI':
            this.delayedBookmarksSync();
            break;
        }
    },

    // nsINavBookmarkObserver
    onItemVisited: function BriefStorage_aOnItemVisited(aItemID, aVisitID, aTime) { },


    // Returns TRUE if an item is a livemark or a folder and is in the home folder.
    isItemInHomeFolder: function BriefStorage_isItemInHomeFolder(aItemID) {
        if (this.homeFolderID === -1)
            return false;

        if (this.homeFolderID === aItemID)
            return true;

        var inHome = false;
        if (this.isItemFolder(aItemID)) {
            var parent = aItemID;
            while (parent !== gPlaces.placesRootId) {
                parent = gPlaces.bookmarks.getFolderIdForItem(parent);
                if (parent === this.homeFolderID) {
                    inHome = true;
                    break;
                }
            }
        }

        return inHome;
    },

    isItemFolder: function BriefStorage_isItemFolder(aItemID) {
        return gPlaces.bookmarks.getItemType(aItemID) === gPlaces.bookmarks.TYPE_FOLDER;
    },

    isItemStoredInDB: function BriefStorage_isItemStoredInDB(aItemID) {
        var stmt = this.checkItemByBookmarkID_stmt;
        stmt.params.bookmarkID = aItemID;
        var isItemStored = stmt.step();
        stmt.reset();
        return isItemStored;
    },

    delayedBookmarksSync: function BriefStorage_delayedBookmarksSync() {
        if (this.bookmarksObserverTimerIsRunning)
            this.bookmarksObserverDelayTimer.cancel();

        this.bookmarksObserverDelayTimer.init(this, BOOKMARKS_OBSERVER_DELAY,
                                              Ci.nsITimer.TYPE_ONE_SHOT);
        this.bookmarksObserverTimerIsRunning = true;
    },

    get checkItemByBookmarkID_stmt BriefStorage_checkItemByBookmarkID_stmt() {
        delete this.__proto__.checkForBookmarkID_stmt;
        return this.__proto__.checkForBookmarkID_stmt = createStatement(
               'SELECT COUNT(1) FROM feeds WHERE feeds.bookmarkID = :bookmarkID');
    },


    classDescription: STORAGE_CLASS_NAME,
    classID: STORAGE_CLASS_ID,
    contractID: STORAGE_CONTRACT_ID,
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


/**
 * Synchronizes the list of feeds stored in the database with
 * the bookmarks available in the user's home folder.
 */
function BookmarksSynchronizer() {
    if (!this.checkHomeFolder())
        return;

    this.newFeeds = [];

    gConnection.beginTransaction();
    try {
        // Get the list of bookmarks and folders in the home folder.
        this.getLiveBookmarks();

        // Get the list of feeds stored in the database.
        this.getFeeds();

        for each (bookmark in this.foundBookmarks) {
            // Search for the bookmarked among the stored feeds.
            let feed = null;
            for (let i = 0; i < this.storedFeeds.length; i++) {
                if (this.storedFeeds[i].feedID == bookmark.feedID) {
                    feed = this.storedFeeds[i];
                    break;
                }
            }

            if (feed) {
                feed.bookmarked = true;
                this.updateFeedFromBookmark(bookmark, feed);
            }
            else {
                this.insertFeed(bookmark);
                if (!bookmark.isFolder)
                    this.newFeeds.push(feed);
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
    if (this.newFeeds.length) {
        var feeds = [];
        for each (feed in this.newFeeds)
            feeds.push(gStorageService.getFeed(feed.feedID));

        var updateService = Cc['@ancestor/brief/updateservice;1'].
                            getService(Ci.nsIBriefUpdateService);
        updateService.updateFeeds(feeds, false);
    }
}

BookmarksSynchronizer.prototype = {

    storedFeeds: null,
    newFeeds: null,
    foundBookmarks: null,
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
                gPlaces.bookmarks.getItemTitle(homeFolder);
            }
            catch (e) {
                gPrefs.clearUserPref('homeFolder');
                folderValid = false;
            }
        }

        return folderValid;
    },


    // Get the list of Live Bookmarks in the user's home folder.
    getLiveBookmarks: function BookmarksSync_getLiveBookmarks() {
        var homeFolder = gPrefs.getIntPref('homeFolder');
        this.foundBookmarks = [];

        var options = gPlaces.history.getNewQueryOptions();
        var query = gPlaces.history.getNewQuery();
        query.setFolders([homeFolder], 1);
        options.excludeItems = true;

        var result = gPlaces.history.executeQuery(query, options);
        this.traversePlacesQueryResults(result.root);
    },


    // Gets all feeds stored in the database.
    getFeeds: function BookmarksSync_getFeeds() {
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


    updateFeedFromBookmark: function BookmarksSync_updateFeedFromBookmark(aItem, aFeed) {
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
            item.title = gPlaces.bookmarks.getItemTitle(node.itemId);
            item.bookmarkID = node.itemId;
            item.rowIndex = this.foundBookmarks.length;
            item.parent = aContainer.itemId.toFixed().toString();

            if (gPlaces.livemarks.isLivemark(node.itemId)) {
                var feedURL = gPlaces.livemarks.getFeedURI(node.itemId).spec;
                item.feedURL = feedURL;
                item.feedID = hashString(feedURL);
                item.isFolder = false;

                this.foundBookmarks.push(item);
            }
            else {
                item.feedURL = '';
                item.feedID = node.itemId.toFixed().toString();
                item.isFolder = true;

                this.foundBookmarks.push(item);

                if (node instanceof Ci.nsINavHistoryContainerResultNode)
                    this.traversePlacesQueryResults(node);
            }
        }

        aContainer.containerOpen = false;
    }

}


function BriefQuery() { }

BriefQuery.prototype = {

    entries: null,
    feeds:   null,
    folders: null,

    read:      false,
    unread:    false,
    starred:   false,
    unstarred: false,
    deleted:   ENTRY_STATE_NORMAL,

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

    setConstraints: function BriefQuery_setConstraints(aFeeds, aEntries, aUnread) {
        this.feeds = aFeeds;
        this.entries = aEntries;
        this.unread = aUnread;
    },


    // nsIBriefQuery
    getEntries: function BriefQuery_getEntries() {
        var select = createStatement(
                     'SELECT entries.id, entries.feedID, entries.entryURL,          ' +
                     '       entries.date, entries.authors, entries.read,           ' +
                     '       entries.starred, entries.updated, entries.bookmarkID,  ' +
                     '       entries_text.title, entries_text.content               ' +
                      this.getQueryStringForSelect());
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
                entry.read = (select.row.read == 1);
                entry.starred = (select.row.starred == 1);
                entry.updated = (select.row.updated == 1);
                entry.bookmarkID = select.row.bookmarkID;
                entry.title = select.row.title;
                entry.content = select.row.content;

                entries.push(entry);
            }
        }
        catch (ex if gConnection.lastError == 1) {
            // Ignore "SQL logic error or missing database" error which full-text search
            // throws when the query doesn't contain at least one non-excluded term.
        }
        finally {
            select.reset();
        }

        return entries;
    },


    // nsIBriefQuery
    getSimpleEntryList: function BriefQuery_getSimpleEntryList() {
        var select = createStatement('SELECT entries.id, entries.feedID ' +
                                     this.getQueryStringForSelect());
        var entries = [];
        var feeds = [];
        try {
            while (select.step()) {
                entries.push(select.row.id);
                var feedID = select.row.feedID;
                if (feeds.indexOf(feedID) == -1)
                    feeds.push(feedID);
            }
        }
        catch (ex if gConnection.lastError == 1) {
            // See BriefQuery.getEntries();
        }
        finally {
            select.reset();
        }

        var bag = Cc['@mozilla.org/hash-property-bag;1'].
                  createInstance(Ci.nsIWritablePropertyBag);
        bag.setProperty('entries', entries);
        bag.setProperty('feeds', feeds);

        return bag;
    },


    // nsIBriefQuery
    getEntryCount: function BriefQuery_getEntryCount() {
        // Optimization: ignore sorting settings.
        [this.sortOrder, temp] = [Ci.nsIBriefQuery.NO_SORT, this.sortOrder];
        var select = createStatement('SELECT COUNT(1) AS count ' +
                                     this.getQueryStringForSelect());
        this.sortOrder = temp;

        var count = 0;
        try {
            select.step();
            count = select.row.count;
        }
        catch (ex if gConnection.lastError == 1) {
            // See BriefQuery.getEntries();
        }
        finally {
            select.reset();
        }
        return count;
    },


    // nsIBriefQuery
    markEntriesRead: function BriefQuery_markEntriesRead(aState) {
        var update = createStatement('UPDATE entries SET read = :read, updated = 0 ' +
                                     this.getQueryString())
        update.params.read = aState ? 1 : 0;

        gConnection.beginTransaction();
        try {
            // Get the list of entries which we deleted, so we can pass it in the
            // notification. Never include those from hidden feeds though - nobody cares
            // about them nor expects to deal with them.
            [this.includeHiddenFeeds, temp] = [false, this.includeHiddenFeeds];
            var changedEntries = this.getSimpleEntryList();
            this.includeHiddenFeeds = false;

            update.execute();
        }
        catch (ex if gConnection.lastError == 1) {
            // See BriefQuery.getEntries();
        }
        finally {
            gConnection.commitTransaction();
        }

        // If any entries were marked, dispatch the notifiaction.
        if (changedEntries.getProperty('entries').length) {
            gObserverService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                             aState ? 'read' : 'unread');
        }
    },


    // nsIBriefQuery
    deleteEntries: function BriefQuery_deleteEntries(aState) {
        var statementString;
        switch (aState) {
            case ENTRY_STATE_NORMAL:
            case ENTRY_STATE_TRASHED:
            case ENTRY_STATE_DELETED:
                statementString = 'UPDATE entries SET deleted = ' + aState +
                                   this.getQueryString();
                break;

            case Ci.nsIBriefQuery.REMOVE_FROM_DATABASE:
                statementString = 'DELETE FROM entries ' + this.getQueryString();
                break;

            default:
                throw('Invalid deleted state.');
        }

        var statement = createStatement(statementString);
        gConnection.beginTransaction();
        try {
            [this.includeHiddenFeeds, temp] = [false, this.includeHiddenFeeds];
            var changedEntries = this.getSimpleEntryList();
            this.includeHiddenFeeds = temp;

            statement.execute();
        }
        catch (ex if gConnection.lastError == 1) {
            // See BriefQuery.getEntries();
        }
        finally {
            gConnection.commitTransaction();
        }

        if (changedEntries.getProperty('entries').length) {
            gObserverService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                             'deleted');
        }
    },


    // nsIBriefQuery
    starEntries: function BriefQuery_starEntries(aState) {
        var update = createStatement(
                     'UPDATE entries SET starred = ?1, bookmarkID = ?2 WHERE id = ?3');

        gConnection.beginTransaction();
        try {
            [this.includeHiddenFeeds, temp] = [false, this.includeHiddenFeeds];
            var changedEntriesList = this.getSimpleEntryList();
            this.includeHiddenFeeds = temp;

            var ioService = Cc['@mozilla.org/network/io-service;1'].
                            getService(Ci.nsIIOService);
            var txnService = Cc['@mozilla.org/browser/placesTransactionsService;1'].
                             getService(Ci.nsIPlacesTransactionsService);
            var tagName = gStringbundle.GetStringFromName('bookmarkedEntryTagName');
            var bms = gPlaces.bookmarks;
            var annos = gPlaces.annotations;

            var changedEntries = this.getEntries();
            for each (entry in changedEntries) {
                if (aState) {
                    var uri = ioService.newURI(entry.entryURL, null, null);
                    var bookmarkID = bms.insertBookmark(gPlaces.unfiledBookmarksFolderId,
                                                        uri, bms.DEFAULT_INDEX, entry.title);
                    gPlaces.tagging.tagURI(uri, [tagName]);
                }
                else {
                    // We have to use a transaction, so that tags are removed too.
                    var txn = txnService.removeItem(entry.bookmarkID);
                    txnService.doTransaction(txn);
                }

                update.params.starred = aState ? 1 : 0;
                update.params.bookmarkID = aState ? bookmarkID : -1;
                update.params.id = entry.id;
                update.execute();
            }
        }
        finally {
            gConnection.commitTransaction();
        }

        if (changedEntriesList.getProperty('entries').length) {
            gObserverService.notifyObservers(changedEntriesList,
                                             'brief:entry-status-changed',
                                             aState ? 'starred' : 'unstarred');
        }
    },


    /**
     * Constructs SQL query constraints based on attributes of this nsIBriefQuery object.
     *
     * @param aForSelect Build a string optimized for a SELECT statement.
     * @returns String containing the part of an SQL statement after the WHERE clause.
     */
    getQueryString: function BriefQuery_getQueryString(aForSelect) {
        var nsIBriefQuery = Components.interfaces.nsIBriefQuery;

        if (aForSelect) {
            var text = ' FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
                       ' INNER JOIN entries_text ON entries.rowid = entries_text.rowid WHERE ';
        }
        else {
            text = ' WHERE entries.rowid IN (SELECT entries.rowid FROM entries INNER JOIN ' +
                   ' feeds ON entries.feedID = feeds.feedID ';
            if (this.searchString || this.sortOrder == nsIBriefQuery.SORT_BY_TITLE)
                text += ' INNER JOIN entries_text ON entries.rowid = entries_text.rowid ';
            text += ' WHERE ';
        }

        if (this.folders) {
            this.effectiveFolders = this.folders;
            var homeFolder = gPrefs.getIntPref('homeFolder');

            // Fill the list of effective folders.
            this.traverseFolderChildren(homeFolder);

            text += '(';
            for (let i = 0; i < this.effectiveFolders.length; i++) {
                text += 'feeds.parent = "' + this.effectiveFolders[i] + '"';
                if (i < this.effectiveFolders.length - 1)
                    text += ' OR ';
            }
            text += ') AND ';
        }

        if (this.feeds) {
            text += '(';
            for (let i = 0; i < this.feeds.length; i++) {
                text += 'entries.feedID = "' + this.feeds[i] + '"';
                if (i < this.feeds.length - 1)
                    text += ' OR ';
            }
            text += ') AND ';
        }

        if (this.entries) {
            text += '(';
            for (let i = 0; i < this.entries.length; i++) {
                text += 'entries.id = "' + this.entries[i] + '"';
                if (i < this.entries.length - 1)
                    text += ' OR ';
            }
            text += ') AND ';
        }

        if (this.searchString)
            text += 'entries_text MATCH \'' + this.searchString.replace("'",' ') +'\' AND ';

        if (this.read)
            text += 'entries.read = 1 AND ';
        if (this.unread)
            text += 'entries.read = 0 AND ';
        if (this.starred)
            text += 'entries.starred = 1 AND ';
        if (this.unstarred)
            text += 'entries.starred = 0 AND ';

        if (this.deleted != nsIBriefQuery.ENTRY_STATE_ANY)
            text += 'entries.deleted = ' + this.deleted + ' AND ';

        if (this.startDate > 0)
            text += 'entries.date >= ' + this.startDate + ' AND ';
        if (this.endDate > 0)
            text += 'entries.date <= ' + this.endDate + ' AND ';

        if (!this.includeHiddenFeeds)
            text += 'feeds.hidden = 0 ';

        // Trim the trailing AND, if there is one.
        text = text.replace(/AND $/, '');
        // If the were no constraints (all entries are matched),
        // we may end up with a dangling WHERE.
        text = text.replace(/WHERE $/, '');

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
                    throw('BriefQuery: wrong sort order, use one the defined constants.');
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

    getQueryStringForSelect: function BriefQuery_getQueryStringForSelect() {
        return this.getQueryString(true);
    },

    traverseFolderChildren: function BriefQuery_traverseFolderChildren(aFolder) {
        var isEffectiveFolder = (this.effectiveFolders.indexOf(aFolder) != -1);
        var items = gStorageService.getAllFeedsAndFolders();

        for (var i = 0; i < items.length; i++) {
            if (items[i].parent == aFolder && items[i].isFolder) {
                if (isEffectiveFolder)
                    this.effectiveFolders.push(items[i].feedID);
                this.traverseFolderChildren(items[i].feedID);
            }
        }
    },

    classDescription: QUERY_CLASS_NAME,
    classID: QUERY_CLASS_ID,
    contractID: QUERY_CONTRACT_ID,
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIBriefQuery])
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
    var dbError = gConnection.lastErrorString;
    var consoleService = Cc['@mozilla.org/consoleservice;1'].
                         getService(Ci.nsIConsoleService);
    consoleService.logStringMessage('Brief database error:\n ' + dbError);
    if (aRethrow)
        throw(aException);
    else
        Components.utils.reportError(aException);
}


function log(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n' + aMessage);
}


var components = [BriefStorageService, BriefQuery];
function NSGetModule(compMgr, fileSpec) XPCOMUtils.generateModule(components)
