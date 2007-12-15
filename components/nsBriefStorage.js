const STORAGE_CLASS_ID = Components.ID('{4C468DA8-7F30-11DB-A690-EBF455D89593}');
const STORAGE_CLASS_NAME = 'mozStorage database component for the Brief extension';
const STORAGE_CONTRACT_ID = '@ancestor/brief/storage;1';

const QUERY_CLASS_ID = Components.ID('{10992573-5d6d-477f-8b13-8b578ad1c95e}');
const QUERY_CLASS_NAME = 'Query to database of the Brief extension';
const QUERY_CONTRACT_ID = '@ancestor/brief/query;1';

const Cc = Components.classes;
const Ci = Components.interfaces;

// How often to manage entry expiration and removing deleted items.
const PURGE_ENTRIES_INTERVAL = 3600*24; // 1 day

// How long to keep entries from feeds no longer in the home folder.
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // 1 week

const BOOKMARKS_OBSERVER_DELAY = 250;

const DATABASE_VERSION = 5;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

var gStorageService = null;

function BriefStorageService() {
    this.observerService = Cc['@mozilla.org/observer-service;1'].
                           getService(Ci.nsIObserverService);

    // The instantiation can't be done on app-startup, because the directory service
    // doesn't work yet, so we perform it on profile-after-change.
    this.observerService.addObserver(this, 'profile-after-change', false);
}

BriefStorageService.prototype = {

    dBConnection:          null,
    feedsAndFoldersCache:  null,
    feedsCache:            null,

    observerService:       null,
    prefs:                 null,

    bookmarksObserverDelayTimer: null,
    bookmarksObserverTimerIsRunning: false,

    // State properties uses by the bookmarks observer.
    batchUpdateInProgress: false,
    homeFolderContentModified: false,

    // Places services
    historyService:   null,
    bookmarksService: null,
    livemarkService:  null,

    instantiate: function BriefStorage_instantiate() {
        var file = Cc['@mozilla.org/file/directory_service;1'].
                   getService(Ci.nsIProperties).
                   get('ProfD', Ci.nsIFile);
        file.append('brief.sqlite');
        var databaseIsNew = !file.exists();

        var storageService = Cc['@mozilla.org/storage/service;1'].
                             getService(Ci.mozIStorageService);
        this.dBConnection = storageService.openDatabase(file);

        if (databaseIsNew)
            this.dBConnection.executeSimpleSQL('PRAGMA user_version = ' + DATABASE_VERSION);

        //this.dBConnection.executeSimpleSQL('DROP TABLE IF EXISTS feeds');
        //this.dBConnection.executeSimpleSQL('DROP TABLE IF EXISTS entries');

        this.dBConnection.executeSimpleSQL('CREATE TABLE IF NOT EXISTS feeds (    ' +
                                           'feedID         TEXT UNIQUE,           ' +
                                           'RDF_URI        TEXT,                  ' + // rename
                                           'feedURL        TEXT,                  ' +
                                           'websiteURL     TEXT,                  ' +
                                           'title          TEXT,                  ' + // obsolete?
                                           'subtitle       TEXT,                  ' +
                                           'imageURL       TEXT,                  ' +
                                           'imageLink      TEXT,                  ' + // obsolete?
                                           'imageTitle     TEXT,                  ' +
                                           'favicon        TEXT,                  ' +
                                           'hidden         INTEGER DEFAULT 0,     ' +
                                           'oldestAvailableEntryDate INTEGER,     ' +
                                           'rowIndex       INTEGER,               ' +
                                           'parent         TEXT,                  ' +
                                           'isFolder       INTEGER,               ' +
                                           'entryAgeLimit  INTEGER DEFAULT 0,     ' +
                                           'maxEntries     INTEGER DEFAULT 0,     ' +
                                           'updateInterval INTEGER DEFAULT 0,     ' +
                                           'lastUpdated    INTEGER DEFAULT 0      ' +
                                           ')');
        this.dBConnection.executeSimpleSQL('CREATE TABLE IF NOT EXISTS entries (' +
                                           'feedID      TEXT,                    ' +
                                           'id          TEXT UNIQUE,             ' +
                                           'secondaryID TEXT,                    ' +
                                           'providedID  TEXT,                    ' +
                                           'entryURL    TEXT,                    ' +
                                           'title       TEXT,                    ' +
                                           'content     TEXT,                    ' +
                                           'date        INTEGER,                 ' +
                                           'authors     TEXT,                    ' +
                                           'read        INTEGER DEFAULT 0,       ' +
                                           'updated     INTEGER DEFAULT 0,       ' +
                                           'starred     INTEGER DEFAULT 0,       ' +
                                           'deleted     INTEGER DEFAULT 0        ' +
                                           ')');

        this.dBConnection.executeSimpleSQL('CREATE INDEX IF NOT EXISTS               ' +
                                           'entries_feedID_index ON entries (feedID) ');
        this.dBConnection.executeSimpleSQL('CREATE INDEX IF NOT EXISTS               ' +
                                           'entries_date_index ON entries (date)     ');

        var getDatabaseVersion = this.dBConnection.createStatement('PRAGMA user_version');
        getDatabaseVersion.executeStep();
        var databaseVersion = getDatabaseVersion.getInt32(0);
        getDatabaseVersion.reset();

        if (databaseVersion < DATABASE_VERSION)
            this.migrateDatabase(databaseVersion);

        this.dBConnection.preload();

        this.prefs = Cc["@mozilla.org/preferences-service;1"].
                     getService(Ci.nsIPrefService).
                     getBranch('extensions.brief.').
                     QueryInterface(Ci.nsIPrefBranch2);
        this.prefs.addObserver('', this, false);

        this.initPlaces();

        this.bookmarksObserverDelayTimer = Cc['@mozilla.org/timer;1'].
                                           createInstance(Ci.nsITimer);

        this.observerService.addObserver(this, 'quit-application', false);
    },


    migrateDatabase: function BriefStorage_migrateDatabase(aPreviousVersion) {
        switch (aPreviousVersion) {

        // Schema version checking has only been introduced in 0.8 beta 1. When migrating
        // from earlier releases we don't know the exact previous version, so we attempt
        // to apply all the changes since the beginning of time.
        case 0:
            // Columns added in 0.6.
            try {
                this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN oldestAvailableEntryDate INTEGER');
                this.dBConnection.executeSimpleSQL('ALTER TABLE entries ADD COLUMN providedID TEXT');
            }
            catch (e) {}

            // Columns and indices added in 0.7.
            try {
                this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN lastUpdated INTEGER');
                this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN updateInterval INTEGER DEFAULT 0');
                this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN entryAgeLimit INTEGER DEFAULT 0');
                this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN maxEntries INTEGER DEFAULT 0');
                this.dBConnection.executeSimpleSQL('ALTER TABLE entries ADD COLUMN authors TEXT');
                this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN rowIndex INTEGER');
                this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN parent TEXT');
                this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN isFolder INTEGER');
                this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN RDF_URI TEXT');
            }
            catch (e) {}

            // Fall through...

        // To 0.8.
        case 1:
            this.dBConnection.executeSimpleSQL('ALTER TABLE entries ADD COLUMN secondaryID TEXT');

            // Brief isn't likely to ever make use of storing both content field
            // and summary field, so we may as well abandon the |summary| column.
            // In the |content| column we will store either the content or when
            // content is unavailable - the summary.
            // To migrate to the new system, we need populate empty |content| columns
            // with |summary| columns.
            var updateEntryContent = this.dBConnection.createStatement(
                'UPDATE entries SET content = summary, summary = "" WHERE content = ""');
            updateEntryContent.execute();
            // Fall through...

        // To 1.0 beta 1
        case 2:
            // There was a bug in 1.0 and 1.0.1 due to which the next step threw an
            // exception for some users. When this happened, the below column was added
            // but the new user_version wasn't set, so Brief was repeating the migration
            // on subsequent runs and failing, because the adding an already existing
            // columns throws an exception.
            // To help users get out that endless loop we use the try...catch block.
            try {
                this.dBConnection.executeSimpleSQL(
                              'ALTER TABLE entries ADD COLUMN updated INTEGER DEFAULT 0');
            }
            catch (e) { }
            // Fall through...

        // To 1.0
        case 3:
            this.dBConnection.executeSimpleSQL('DROP INDEX IF EXISTS entries_id_index');
            this.dBConnection.executeSimpleSQL('DROP INDEX IF EXISTS feeds_feedID_index');
            // Fall through...

        // To 1.2
        case 4:
            // This version changed how IDs are generated. Below we recompute IDs,
            // but only for entries which are still available in the feed.
            var selectRecentEntries = this.dBConnection.createStatement(
                'SELECT entries.feedID, entries.providedID, entries.id           ' +
                'FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID  ' +
                'WHERE entries.date >= feeds.oldestAvailableEntryDate            ');

            var updateEntryID = this.dBConnection.createStatement(
                'UPDATE OR IGNORE entries SET id = ?1 WHERE id = ?2');

            this.dBConnection.beginTransaction();

            try {
                var entries = [];
                while (selectRecentEntries.executeStep()) {
                    var entry = {};
                    entry.feedID = selectRecentEntries.getString(0);
                    entry.providedID = selectRecentEntries.getString(1);
                    entry.id = selectRecentEntries.getString(2);
                    entries.push(entry);
                }
                selectRecentEntries.reset();

                for each (entry in entries) {
                    if (entry.providedID) {
                        var newID = hashString(entry.feedID + entry.providedID)

                        updateEntryID.bindStringParameter(0, newID);
                        updateEntryID.bindStringParameter(1, entry.id);
                        updateEntryID.execute();
                    }
                }
            }
            catch (e) {
                this.logDatabaseError(e);
            }
            finally {
                this.dBConnection.commitTransaction();
            }
            // Fall through...

        }

        this.dBConnection.executeSimpleSQL('PRAGMA user_version = ' + DATABASE_VERSION)
    },


    // nsIBriefStorage
    getFeed: function BriefStorage_getFeed(aFeedID) {
        var foundFeed = null;
        var feeds = this.getFeedsAndFolders({});
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
        var feeds = this.getFeedsAndFolders({});
        for (var i = 0; i < feeds.length; i++) {
            if (feeds[i].bookmarkID == aBookmarkID) {
                foundFeed = feeds[i];
                break;
            }
        }
        return foundFeed;
    },


    // nsIBriefStorage
    getAllFeeds: function BriefStorage_getAllFeeds(aLength) {
        if (!this.feedsCache)
            this.buildFeedsCache();

        // Set the |value| property of the out parameter object. XPConnect needs
        // this in order to return a array.
        aLength.value = this.feedsCache.length;
        return this.feedsCache;
    },


    // nsIBriefStorage
    getFeedsAndFolders: function BriefStorage_getFeedsAndFolders(aLength) {
        if (!this.feedsAndFoldersCache)
            this.buildFeedsCache();

        // Set the |value| property of the out parameter object. XPConnect needs
        // this in order to return a array.
        aLength.value = this.feedsAndFoldersCache.length;
        return this.feedsAndFoldersCache;
    },


    buildFeedsCache: function BriefStorage_buildFeedsCache() {
        this.feedsCache = [];
        this.feedsAndFoldersCache = [];

        var select = this.dBConnection.
            createStatement('SELECT  feedID, feedURL, websiteURL, title,               ' +
                            '        subtitle, imageURL, imageLink, imageTitle,        ' +
                            '        favicon, lastUpdated, oldestAvailableEntryDate,   ' +
                            '        rowIndex, parent, isFolder, RDF_URI,              ' +
                            '        entryAgeLimit, maxEntries, updateInterval         ' +
                            'FROM feeds                                                ' +
                            'WHERE hidden = 0                                          ' +
                            'ORDER BY rowIndex ASC                                     ');
        try {
            while (select.executeStep()) {
                var feed = Cc['@ancestor/brief/feed;1'].createInstance(Ci.nsIBriefFeed);
                feed.feedID = select.getString(0);
                feed.feedURL = select.getString(1);
                feed.websiteURL = select.getString(2);
                feed.title = select.getString(3);
                feed.subtitle = select.getString(4);
                feed.imageURL = select.getString(5);
                feed.imageLink = select.getString(6);
                feed.imageTitle = select.getString(7);
                feed.favicon = select.getString(8);
                feed.lastUpdated = select.getInt64(9);
                feed.oldestAvailableEntryDate = select.getInt64(10);
                feed.rowIndex = select.getInt32(11);
                feed.parent = select.getString(12);
                feed.isFolder = select.getInt32(13) == 1;
                feed.bookmarkID = select.getString(14);
                feed.entryAgeLimit = select.getInt32(15);
                feed.maxEntries = select.getInt32(16);
                feed.updateInterval = select.getInt64(17);

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
        var oldestEntryDate = Date.now();

        this.preCreateUpdatingStatements();

        // Count the unread entries, to compare their number later.
        var unreadEntriesQuery = Cc['@ancestor/brief/query;1'].
                                 createInstance(Ci.nsIBriefQuery);
        unreadEntriesQuery.setConditions(aFeed.feedID, null, true);
        var oldUnreadCount = unreadEntriesQuery.getEntriesCount();

        this.dBConnection.beginTransaction();

        try {
            var entries = aFeed.getEntries({});

            for (var i = 0; i < entries.length; i++) {
                entry = entries[i];

                this.processEntry(entry, aFeed);

                // Track the date of the oldest entry.
                if (entry.date && entry.date < oldestEntryDate)
                    oldestEntryDate = entry.date;
            }

            this.updateFeedData(aFeed, oldestEntryDate);
        }
        catch (e) {
            this.logDatabaseError(e);
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        var newUnreadCount = unreadEntriesQuery.getEntriesCount();
        var newEntriesCount = newUnreadCount - oldUnreadCount;
        var subject = Cc["@mozilla.org/variant;1"].createInstance(Ci.nsIWritableVariant);
        subject.setAsInt32(newEntriesCount);
        this.observerService.notifyObservers(subject, 'brief:feed-updated', aFeed.feedID);
    },


    preCreateUpdatingStatements: function BriefStorage_preCreateUpdatingStatement() {
        this.insertEntry_stmt = this.dBConnection.createStatement(
                          'INSERT OR IGNORE INTO entries                         ' +
                          '(                                                     ' +
                          'feedID, id, secondaryID, providedID, entryURL,        ' +
                          'title,  content, date, authors, read                  ' +
                          ')                                                     ' +
                          'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)      ');
        this.updateEntry_stmt = this.dBConnection.createStatement(
                          'UPDATE entries       ' +
                          'SET content = ?1,    ' +
                          '    date    = ?2,    ' +
                          '    authors = ?3,    ' +
                          '    read    = 0,     ' +
                          '    updated = 1      ' +
                          'WHERE id = ?4        ');

        this.checkByPrimaryID_stmt = this.dBConnection.
                        createStatement('SELECT date FROM entries WHERE id = ?');
        this.checkBySecondaryID_stmt = this.dBConnection.
                        createStatement('SELECT date FROM entries WHERE secondaryID = ?');
    },


    processEntry: function BriefStorage_processEntry(aEntry, aFeed) {

        var content = aEntry.content || aEntry.summary;

        // Strip tags
        var title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : '';

        // All file:// URIs are treated as same-origin which would let a script
        // running in our template a page access local files using XHR.
        content = content ? content.replace(/XMLHttpRequest/g, 'XMLHTTPRequest') : '';
        var entryURL = aEntry.entryURL ? aEntry.entryURL.replace(/XMLHttpRequest/g, 'XMLHTTPRequest') : '';
        var authors = aEntry.authors ? aEntry.authors.replace(/XMLHttpRequest/g, 'XMLHTTPRequest') : '';

        // Now the fun part - the logic of computing unique entry IDs and inserting
        // entries.
        // We have two types of IDs: primary and secondary. The former is used as a
        // unique identifier at all times, while the latter is only used during updating,
        // to work around a bug (see later). Below are two sets of fields used to
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
        // having an empty GUID effects in a different hash which leads to
        // annoying duplication of entries. In such case, we work around it by
        // checking for entry's existance using the secondary hash, which doesn't
        // include the GUID and is therefore immune to that problem.
        //
        // While checking, we also get the date which we'll need to see if the
        // stored entry needs to be updated.
        if (!aEntry.id) {
            var check = this.checkBySecondaryID_stmt;
            check.bindStringParameter(0, secondaryID);
            var entryAlreadyStored = check.executeStep();
            if (entryAlreadyStored)
                var storedEntryDate = check.getInt64(0);
            check.reset();
        }
        else {
            check = this.checkByPrimaryID_stmt;
            check.bindStringParameter(0, primaryID);
            entryAlreadyStored = check.executeStep();
            if (entryAlreadyStored)
                storedEntryDate = check.getInt64(0);
            check.reset();
        }


        // If the entry is already present in the database, compare if the downloaded
        // entry has a newer date than the stored one and if so, update the data and
        // mark the entry as unread. Otherwise, insert it if it isn't present yet.
        if (entryAlreadyStored) {

            if (aEntry.date && storedEntryDate < aEntry.date) {
                var update = this.updateEntry_stmt;
                update.bindStringParameter(0, content);
                update.bindInt64Parameter(1, aEntry.date)
                update.bindStringParameter(2, authors);
                update.bindStringParameter(3, primaryID);

                update.execute();
            }

        }
        else {
            var insert = this.insertEntry_stmt;
            insert.bindStringParameter(0, aFeed.feedID);
            insert.bindStringParameter(1, primaryID);
            insert.bindStringParameter(2, secondaryID);
            insert.bindStringParameter(3, entry.id);
            insert.bindStringParameter(4, entryURL);
            insert.bindStringParameter(5, title);
            insert.bindStringParameter(6, content);
            insert.bindInt64Parameter(7, aEntry.date ? aEntry.date : now);
            insert.bindStringParameter(8, authors);
            insert.bindInt32Parameter(9, 0);

            insert.execute();
        }
    },


    updateFeedData: function BriefStorage_updateFeedData(aFeed, aOldestEntryDate) {

        // Do not update the title, because it's taken from the bookmarks.
        var updateFeed = this.dBConnection.createStatement(
                         'UPDATE feeds                        ' +
                         'SET websiteURL  = ?1,               ' +
                         '    subtitle    = ?2,               ' +
                         '    imageURL    = ?3,               ' +
                         '    imageLink   = ?4,               ' +
                         '    imageTitle  = ?5,               ' +
                         '    favicon     = ?6,               ' +
                         '    oldestAvailableEntryDate = ?7,  ' +
                         '    lastUpdated = ?8                ' +
                         'WHERE feedID = ?9                   ');
        updateFeed.bindStringParameter(0, aFeed.websiteURL);
        updateFeed.bindStringParameter(1, aFeed.subtitle);
        updateFeed.bindStringParameter(2, aFeed.imageURL);
        updateFeed.bindStringParameter(3, aFeed.imageLink);
        updateFeed.bindStringParameter(4, aFeed.imageTitle);
        updateFeed.bindStringParameter(5, aFeed.favicon);
        updateFeed.bindInt64Parameter(6,  aOldestEntryDate);
        updateFeed.bindInt64Parameter(7,  Date.now());
        updateFeed.bindStringParameter(8, aFeed.feedID);
        updateFeed.execute();

        // Update the cache.
        var cachedFeed = this.getFeed(aFeed.feedID);
        cachedFeed.websiteURL = aFeed.websiteURL;
        cachedFeed.subtitle = aFeed.subtitle;
        cachedFeed.imageURL = aFeed.imageURL;
        cachedFeed.imageLink = aFeed.imageLink;
        cachedFeed.imageTitle = aFeed.imageTitle;
        cachedFeed.favicon = aFeed.favicon;
        cachedFeed.lastUpdated = Date.now();
        cachedFeed.oldestAvailableEntryDate = aOldestEntryDate;
    },


    // nsIBriefStorage
    setFeedOptions: function BriefStorage_setFeedOptions(aFeed) {
        var update = this.dBConnection.
            createStatement('UPDATE feeds            ' +
                            'SET entryAgeLimit  = ?, ' +
                            '    maxEntries     = ?, ' +
                            '    updateInterval = ?  ' +
                            'WHERE feedID = ?');

        update.bindInt32Parameter(0, aFeed.entryAgeLimit);
        update.bindInt32Parameter(1, aFeed.maxEntries);
        update.bindInt64Parameter(2, aFeed.updateInterval);
        update.bindStringParameter(3, aFeed.feedID);

        update.execute();

        // Update the cache if neccassary (it may not be if nsIBriefFeed instance that was
        // passed to us was itself taken from the cache).
        var feed = this.getFeed(aFeed.feedID);
        if (feed != aFeed) {
            feed.entryAgeLimit = aFeed.entryAgeLimit;
            feed.maxEntries = aFeed.maxEntries;
            feed.updateInterval = aFeed.updateInterval;
        }
    },


    // nsIBriefStorage
    compactDatabase: function BriefStorage_compactDatabase() {
        this.purgeEntries(false);
        this.dBConnection.executeSimpleSQL('VACUUM');
    },


    // Deletes entries that are outdated or exceed the max number per feed based.
    deleteExpiredEntries: function BriefStorage_deleteRedundantEntries() {
        var expireEntriesGlobal = this.prefs.getBoolPref('database.expireEntries');
        var useGlobalStoreLimit = this.prefs.getBoolPref('database.limitStoredEntries');
        var globalExpirationAge = this.prefs.getIntPref('database.entryExpirationAge');
        var globalMaxEntries = this.prefs.getIntPref('database.maxStoredEntries');

        // globalExpirationAge is in days, convert it to miliseconds
        var globalEdgeDate = Date.now() - globalExpirationAge * 86400000;
        var feeds = this.getAllFeeds({});

        const STATE_TRASHED = Ci.nsIBriefQuery.ENTRY_STATE_TRASHED;
        const STATE_NORMAL = Ci.nsIBriefQuery.ENTRY_STATE_NORMAL;

        var deleteOutdatedGlobal = this.dBConnection.createStatement(
            'UPDATE entries SET deleted = ?1                                   ' +
            'WHERE id IN                                                       ' +
            '(                                                                 ' +
            '   SELECT entries.id                                              ' +
            '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
            '   WHERE entries.deleted = ?2 AND                                 ' +
            '         feeds.entryAgeLimit = 0 AND                              ' +
            '         entries.starred = 0 AND                                  ' +
            '         entries.date < ?3                                        ' +
            ')                                                                 ');

        var deleteOutdatedPerFeed = this.dBConnection.createStatement(
            'UPDATE entries SET deleted = ?1  ' +
            'WHERE entries.deleted = ?2 AND   ' +
            '      starred = 0 AND            ' +
            '      entries.date < ?3 AND      ' +
            '      feedID = ?4                ');

        var deleteExcessive = this.dBConnection.createStatement(
            'UPDATE entries SET deleted = ?1       ' +
            'WHERE id IN                           ' +
            '(                                     ' +
            '    SELECT id                         ' +
            '    FROM entries                      ' +
            '    WHERE deleted = ?2 AND            ' +
            '          starred = 0 AND             ' +
            '          feedID = ?3                 ' +
            '    ORDER BY date ASC                 ' +
            '    LIMIT ?4                          ' +
            ')                                     ');

        var getEntriesCountForFeed = this.dBConnection.createStatement(
            'SELECT COUNT(1) FROM entries  ' +
            'WHERE feedID = ? AND          ' +
            '      starred = 0 AND         ' +
            '      deleted = ?             ');

        this.dBConnection.beginTransaction();
        try {
            // Delete outdated entries in feeds that don't have per-feed setting enabled.
            if (expireEntriesGlobal) {
                deleteOutdatedGlobal.bindInt32Parameter(0, STATE_TRASHED);
                deleteOutdatedGlobal.bindInt32Parameter(1, STATE_NORMAL)
                deleteOutdatedGlobal.bindInt64Parameter(2, globalEdgeDate);
                deleteOutdatedGlobal.execute();
            }

            // Delete entries exceeding the max number. We have to do it feed by feed.
            var entryCount, difference, i;
            for (i = 0; i < feeds.length; i++) {
                // Count the number of entries in the feed.
                getEntriesCountForFeed.bindStringParameter(0, feeds[i].feedID);
                getEntriesCountForFeed.bindStringParameter(1, STATE_NORMAL);
                getEntriesCountForFeed.executeStep()
                entryCount = getEntriesCountForFeed.getInt32(0);
                getEntriesCountForFeed.reset();

                // Calculate the difference between the current number of entries and the
                // limit specified in either the per-feed preferences stored in the
                // database or the global preference.
                difference = 0;
                if (feeds[i].maxEntries > 0)
                    difference = entryCount - feeds[i].maxEntries
                else if (useGlobalStoreLimit)
                    difference = entryCount - globalMaxEntries;

                if (difference > 0) {
                    deleteExcessive.bindInt32Parameter(0, STATE_TRASHED);
                    deleteExcessive.bindInt32Parameter(1, STATE_NORMAL)
                    deleteExcessive.bindStringParameter(2, feeds[i].feedID);
                    deleteExcessive.bindInt64Parameter(3, difference);
                    deleteExcessive.execute();
                }
            }

            // Delete outdated entries based on the per-feed limit.
            var edgeDate, i;
            for (i = 0; i < feeds.length; i++) {
                if (feeds[i].entryAgeLimit > 0) {
                    edgeDate = Date.now() - feeds[i].entryAgeLimit * 86400000;
                    deleteOutdatedPerFeed.bindInt32Parameter(0, STATE_TRASHED);
                    deleteOutdatedPerFeed.bindInt32Parameter(1, STATE_NORMAL);
                    deleteOutdatedPerFeed.bindInt64Parameter(2, edgeDate);
                    deleteOutdatedPerFeed.bindStringParameter(3, feeds[i].feedID);
                    deleteOutdatedPerFeed.execute();
                }
            }
        }
        finally {
            this.dBConnection.commitTransaction();
        }

    },


    // Moves expired entries to Trash and permanently removes the deleted items from
    // database.
    purgeEntries: function BriefStorage_purgeDeletedEntries(aDeleteExpired) {
        if (aDeleteExpired)
            this.deleteExpiredEntries();

        var removeEntries = this.dBConnection.createStatement(
            'DELETE FROM entries                                                              ' +
            'WHERE id IN                                                                      ' +
            '(                                                                                ' +
            '   SELECT entries.id                                                             ' +
            '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID                ' +
            '   WHERE (entries.deleted = ? AND feeds.oldestAvailableEntryDate > entries.date) ' +
            '         OR (? - feeds.hidden > ? AND feeds.hidden != 0)                         ' +
            ')                                                                                ');
        var removeFeeds = this.dBConnection.createStatement(
                'DELETE FROM feeds WHERE (? - feeds.hidden > ?) AND feeds.hidden != 0');

        this.dBConnection.beginTransaction()
        try {
            removeEntries.bindInt32Parameter(0, Ci.nsIBriefQuery.ENTRY_STATE_DELETED);
            removeEntries.bindInt64Parameter(1, Date.now());
            removeEntries.bindInt64Parameter(2, DELETED_FEEDS_RETENTION_TIME);
            removeEntries.execute();

            removeFeeds.bindInt64Parameter(0, Date.now());
            removeFeeds.bindInt64Parameter(1, DELETED_FEEDS_RETENTION_TIME);
            removeFeeds.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        // Prefs can only store longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        this.prefs.setIntPref('database.lastPurgeTime', now);
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

                var lastPurgeTime = this.prefs.getIntPref('database.lastPurgeTime');
                if (now - lastPurgeTime > PURGE_ENTRIES_INTERVAL)
                    this.purgeEntries(true);

                this.bookmarksService.removedObserver(this);

                this.prefs.removeObserver('', this);
                this.observerService.removeObserver(this, 'quit-application');
                this.observerService.removeObserver(this, 'profile-after-change');

                this.bookmarksObserverDelayTimer = null;
                break;

            case 'timer-callback':
                this.bookmarksObserverTimerIsRunning = false;
                this.syncWithBookmarks();
                break;

            case 'nsPref:changed':
                switch (aData) {
                    case 'homeFolder':
                        this.syncWithBookmarks();
                        break;
                }
                break;
        }
    },


    // nsIBriefStorage
    // XXX This function is ridiculous, it needs to be split up and rewritten.
    syncWithBookmarks: function BriefStorage_syncWithBookmarks() {
        this.bookmarkItems = [];

        var homeFolder = this.prefs.getIntPref('homeFolder');

        if (!homeFolder || homeFolder == -1) {
            var hideAllFeeds = this.dBConnection.createStatement('UPDATE feeds SET hidden = ?');
            hideAllFeeds.bindInt64Parameter(0, Date.now());
            hideAllFeeds.execute();

            this.feedsCache = this.feedsAndFoldersCache = null;
            this.observerService.notifyObservers(null, 'brief:invalidate-feedlist', '');
            return;
        }

        // Get the current Live Bookmarks.
        try {
            // This will throw if the homeFolder was deleted.
            this.bookmarksService.getItemTitle(homeFolder);
        }
        catch (e) {
            this.onHomeFolderRemoved();
            return;
        }

        var options = this.historyService.getNewQueryOptions();
        var query = this.historyService.getNewQuery();

        query.setFolders([homeFolder], 1);
        options.excludeItems = true;
        var result = this.historyService.executeQuery(query, options);

        this.traversePlacesQueryResults(result.root);

        this.dBConnection.beginTransaction();
        try {
            var selectAll = this.dBConnection.
                createStatement('SELECT feedID, title, rowIndex, isFolder, parent, ' +
                                '       RDF_URI, hidden                            ' +
                                'FROM feeds                                        ');

            var insertItem = this.dBConnection.
                createStatement('INSERT OR IGNORE INTO feeds                                   ' +
                                '(feedID, feedURL, title, rowIndex, isFolder, parent, RDF_URI) ' +
                                'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)                           ');

            var updateFeed = this.dBConnection.
                createStatement('UPDATE feeds                                                     ' +
                                'SET title = ?, rowIndex = ?, parent = ?, RDF_URI = ?, hidden = 0 ' +
                                'WHERE feedID = ?                                                 ');

            var removeFeed = this.dBConnection.
                createStatement('DELETE FROM feeds WHERE feedID = ?');
            var hideFeed = this.dBConnection.
                createStatement('UPDATE feeds SET hidden = ? WHERE feedID =?');

            // Get all feeds currently in the database.
            var feeds = [];
            while (selectAll.executeStep()) {
                var feed = {};
                feed.feedID = selectAll.getString(0);
                feed.title = selectAll.getString(1);
                feed.rowIndex = selectAll.getInt32(2);
                feed.isFolder = selectAll.getInt32(3) == 1;
                feed.parent = selectAll.getString(4);
                feed.bookmarkID = selectAll.getString(5);
                feed.hidden = selectAll.getInt64(6);
                feeds.push(feed);
            }

            // Check if there are any new bookmarks among the just retrieved ones and add
            // them.
            var item, feed, found;
            var addedFeedIDs = [];
            var invalidateFeedList = false;
            for (var i = 0; i < this.bookmarkItems.length; i++) {
                item = this.bookmarkItems[i];
                found = false;

                // Search for the bookmark by iterating over all the feeds in the database.
                for (var j = 0; j < feeds.length; j++) {
                    feed = feeds[j];
                    if (feed.feedID == item.feedID) {
                        // Found it, the bookmark is already in the database.
                        found = true;
                        break;
                    }
                }

                // If the bookmark wasn't found in the database, add it.
                if (!found) {
                    // Invalidate cache since feeds table is about to change
                    this.feedsCache = this.feedsAndFoldersCache = null;

                    insertItem.bindStringParameter(0, item.feedID);
                    insertItem.bindStringParameter(1, item.feedURL || null);
                    insertItem.bindStringParameter(2, item.title);
                    insertItem.bindInt32Parameter(3, item.rowIndex)
                    insertItem.bindInt32Parameter(4, item.isFolder ? 1 : 0);
                    insertItem.bindStringParameter(5, item.parent);
                    insertItem.bindStringParameter(6, item.bookmarkID);
                    insertItem.execute();

                    this.observerService.notifyObservers(null,'brief:feed-added', item.feedID);
                    invalidateFeedList = true;

                    if (!item.isFolder)
                        addedFeedIDs.push(item.feedID);
                }
                else {
                    // Mark that the feed is still in bookmarks.
                    feed.isInBookmarks = true;

                    // If the bookmark was found in the database then check if its row is
                    // up-to-date.
                    if (item.rowIndex != feed.rowIndex || item.parent != feed.parent ||
                       item.title != feed.title || item.bookmarkID != feed.bookmarkID ||
                       feed.hidden > 0) {

                        // Invalidate cache since feeds table is about to change.
                        this.feedsCache = this.feedsAndFoldersCache = null;

                        updateFeed.bindStringParameter(0, item.title);
                        updateFeed.bindInt32Parameter(1, item.rowIndex);
                        updateFeed.bindStringParameter(2, item.parent);
                        updateFeed.bindStringParameter(3, item.bookmarkID);
                        updateFeed.bindStringParameter(4, item.feedID);
                        updateFeed.execute();

                        if (item.rowIndex != feed.rowIndex || item.parent != feed.parent ||
                           feed.hidden > 0) {
                            // If it has been row index, parent or hidden state that
                            // changed, then the whole feed list tree in the Brief window
                            // has to be rebuilt.
                            invalidateFeedList = true;
                        }
                        else {
                            // If only the title has changed, the feed list can be updated
                            // incrementally, so we send a different notification.
                            this.observerService.notifyObservers(null,
                                                                 'brief:feed-title-changed',
                                                                 item.feedID);
                        }
                    }
                }
            }

            // Finally, hide any feeds that are no longer bookmarked.
            for (i = 0; i < feeds.length; i++) {
                feed = feeds[i];
                if (!feed.isInBookmarks && feed.hidden == 0) {

                    // Invalidate cache since feeds table is about to change.
                    this.feedsCache = this.feedsAndFoldersCache = null;

                    if (feed.isFolder) {
                        removeFeed.bindStringParameter(0, feed.feedID);
                        removeFeed.execute();
                    }
                    else {
                        hideFeed.bindInt64Parameter(0, Date.now());
                        hideFeed.bindStringParameter(1, feed.feedID);
                        hideFeed.execute();
                    }

                    invalidateFeedList = true;
                }
            }
        }
        finally {
            this.dBConnection.commitTransaction();
            if (invalidateFeedList)
                this.observerService.notifyObservers(null, 'brief:invalidate-feedlist', '');
        }

        // Update newly addded feeds, if any.
        var addedFeeds = [], feed;
        for (var i = 0; i < addedFeedIDs.length; i++) {
            feed = this.getFeed(addedFeedIDs[i]);
            addedFeeds.push(feed);
        }
        if (addedFeeds.length > 0) {
            var updateService = Cc['@ancestor/brief/updateservice;1'].
                                getService(Ci.nsIBriefUpdateService);
            updateService.fetchFeeds(addedFeeds, addedFeeds.length, false);
        }

    },

    onHomeFolderRemoved: function BriefStorage_onHomeFolderRemoved() {
        this.prefs.clearUserPref('homeFolder');

        var hideAllFeeds = this.dBConnection.createStatement('UPDATE feeds SET hidden = ?');
        hideAllFeeds.bindInt64Parameter(0, Date.now());
        hideAllFeeds.execute();

        this.feedsCache = this.feedsAndFoldersCache = null;
        this.observerService.notifyObservers(null, 'brief:invalidate-feedlist', '');
    },


    initPlaces: function BriefStorage_initPlaces() {
        this.historyService   = Cc['@mozilla.org/browser/nav-history-service;1'].
                                  getService(Ci.nsINavHistoryService);
        this.bookmarksService = Cc['@mozilla.org/browser/nav-bookmarks-service;1'].
                                  getService(Ci.nsINavBookmarksService);
        this.livemarkService  = Cc['@mozilla.org/browser/livemark-service;2'].
                                  getService(Ci.nsILivemarkService);

        this.bookmarksService.addObserver(this, false);
    },


    traversePlacesQueryResults: function BriefStorage_traversePlacesQueryResults(aContainer) {
        aContainer.containerOpen = true;

        for (var i = 0; i < aContainer.childCount; i++) {
            var node = aContainer.getChild(i);

            if (node.type != Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER)
                continue;

            item = {};
            item.title = this.bookmarksService.getItemTitle(node.itemId);
            item.bookmarkID = node.itemId;
            item.rowIndex = this.bookmarkItems.length;
            item.parent = aContainer.itemId;

            if (this.livemarkService.isLivemark(node.itemId)) {
                var feedURL = this.livemarkService.getFeedURI(node.itemId).spec;
                item.feedURL = feedURL;
                item.feedID = hashString(feedURL);
                item.isFolder = false;

                this.bookmarkItems.push(item);
            }
            else {
                item.feedURL = '';
                item.feedID = node.itemId;
                item.isFolder = true;

                this.bookmarkItems.push(item);

                if (node instanceof Ci.nsINavHistoryContainerResultNode)
                    this.traversePlacesQueryResults(node);
            }
        }

        aContainer.containerOpen = false;
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
        if (this.isItemInHomeFolder(aItemID)) {
            if (this.batchUpdateInProgress)
                this.homeFolderContentModified = true;
            else
                this.delayedBookmarksSync();
        }
    },

    // nsINavBookmarkObserver
    onItemRemoved: function BriefStorage_onItemRemoved(aItemID, aFolder, aIndex) {
        if (this.getFeedByBookmarkID(aItemID) || this.prefs.getIntPref('homeFolder') == aItemID) {

            if (this.batchUpdateInProgress)
                this.homeFolderContentModified = true;
            else
                this.delayedBookmarksSync();
        }
    },

    // nsINavBookmarkObserver
    onItemMoved: function BriefStorage_onItemMoved(aItemID, aOldParent, aOldIndex,
                                                   aNewParent, aNewIndex) {
        var inFeeds = !!this.getFeedByBookmarkID(aItemID);

        if (inFeeds || this.isItemInHomeFolder(aItemID)) {
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
            var update = this.dBConnection.createStatement(
                         'UPDATE feeds SET title = ? WHERE feedID = ?');

            update.bindStringParameter(0, aValue);
            update.bindStringParameter(1, feed.feedID);
            update.execute();

            // Update the cached item.
            feed.title = aValue;

            this.observerService.notifyObservers(null, 'brief:feed-title-changed',
                                                 feed.feedID);
            break;

        case 'livemark/feedURI':
            this.delayedBookmarksSync();
            break;
        }
    },

    // nsINavBookmarkObserver
    aOnItemVisited: function BriefStorage_aOnItemVisited(aItemID, aVisitID, aTime) { },


    // Returns TRUE if an item is a livemark or a folder and if it is in the home folder.
    isItemInHomeFolder: function BriefStorage_isItemInHomeFolder(aItemID) {
        var homeFolderID = this.prefs.getIntPref('homeFolder');
        if (homeFolderID == -1)
            return false;

        var inHome = false;

        var typeFolder = this.bookmarksService.TYPE_FOLDER;
        var isFolder = (this.bookmarksService.getItemType(aItemID) == typeFolder);

        if (isFolder) {
            var parent = aItemID;

            while (parent != this.bookmarksService.bookmarksRoot) {
                parent = this.bookmarksService.getFolderIdForItem(parent);
                if (parent == homeFolderID) {
                    inHome = true;
                    break;
                }
            }
        }

        return inHome;
    },

    delayedBookmarksSync: function BriefStorage_delayedBookmarksSync() {
        if (this.bookmarksObserverTimerIsRunning)
            this.bookmarksObserverDelayTimer.cancel();

        this.bookmarksObserverDelayTimer.init(this, BOOKMARKS_OBSERVER_DELAY, Ci.nsITimer.TYPE_ONE_SHOT);
        this.bookmarksObserverTimerIsRunning = true;
    },


    logDatabaseError: function BriefStorage_logDatabaseError(aException) {
        var error = this.dBConnection.lastErrorString;
        var consoleService = Cc['@mozilla.org/consoleservice;1'].
                             getService(Ci.nsIConsoleService);
        consoleService.logStringMessage('Brief database error:\n ' + error + '\n\n ' +
                                        aException);
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

function BriefQuery() {
    this.observerService = Cc['@mozilla.org/observer-service;1'].
                             getService(Ci.nsIObserverService);
}

BriefQuery.prototype = {

    entries: '',
    feeds:   '',
    folders: '',

    read:      false,
    unread:    false,
    starred:   false,
    unstarred: false,
    deleted:   Components.interfaces.nsIBriefQuery.ENTRY_STATE_NORMAL,

    searchString: '',

    startDate: 0,
    endDate:   0,

    limit:  0,
    offset: 1,

    sortOrder: Components.interfaces.nsIBriefQuery.NO_SORT,
    sortDirection: Components.interfaces.nsIBriefQuery.SORT_DESCENDING,

    includeHiddenFeeds: false,

    // When |BriefQuery.folders| is set, it's not enough to take the feeds from these
    // folders alone - we also have to consider their subfolders. And because feeds have
    // no knowledge about the folders they are in besides their direct parent, we have
    // to compute actual ("effective") folders list when creating the query.
    effectiveFolders: null,

    get dBConnection() {
        return gStorageService.dBConnection;
    },

    setConditions: function BriefQuery_setConditions(aFeeds, aEntries, aUnread) {
        this.feeds = aFeeds;
        this.entries = aEntries;
        this.unread = aUnread;
    },


    // nsIBriefQuery
    getEntries: function BriefQuery_getEntries(entryCount) {
        var statement = 'SELECT entries.id,      entries.feedID,  entries.entryURL, ' +
                        '       entries.title,   entries.content, entries.date,     ' +
                        '       entries.authors, entries.read,    entries.starred,  ' +
                        '       entries.updated                                     ' +
                         this.getQueryTextForSelect();

        var select = this.dBConnection.createStatement(statement);

        var entries = new Array();
        try {
            while (select.executeStep()) {
                var entry = Cc['@ancestor/brief/feedentry;1'].
                            createInstance(Ci.nsIBriefFeedEntry);
                entry.id = select.getString(0);
                entry.feedID = select.getString(1);
                entry.entryURL = select.getString(2);
                entry.title = select.getString(3);
                entry.content = select.getString(4);
                entry.date = select.getInt64(5);
                entry.authors = select.getString(6);
                entry.read = (select.getInt32(7) == 1);
                entry.starred = (select.getInt32(8) == 1);
                entry.updated = (select.getInt32(9) == 1);

                entries.push(entry);
            }
        }
        finally {
            select.reset();
        }
        entryCount.value = entries.length;
        return entries;
    },


    // nsIBriefQuery
    getSerializedEntries: function BriefQuery_getSerializedEntries() {
        var statement = 'SELECT entries.id, entries.feedID ' + this.getQueryTextForSelect();
        var select = this.dBConnection.createStatement(statement);

        var entries = [];
        var feeds = [];
        try {
            while (select.executeStep()) {
                // |array[array.length] = x| is faster than |array.push(x)| (bug 385393)
                entries[entries.length] = select.getString(0);

                var feedID = select.getString(1);
                if (feeds.indexOf(feedID) == -1)
                    feeds[feeds.length] = feedID;
            }
        }
        finally {
            select.reset();
        }

        var bag = Cc['@mozilla.org/hash-property-bag;1'].
                  createInstance(Ci.nsIWritablePropertyBag2);
        bag.setPropertyAsAString('entries', entries.join(' '));
        bag.setPropertyAsAString('feeds', feeds.join(' '));

        return bag;
    },


    // nsIBriefQuery
    getEntriesCount: function BriefQuery_getEntriesCount() {
        // Optimization: ignore sorting settings.
        var oldSortOrder = this.sortOrder;
        this.sortOrder = Ci.nsIBriefQuery.NO_SORT;

        var statement = 'SELECT COUNT(1) ' + this.getQueryTextForSelect();
        var select = this.dBConnection.createStatement(statement);

        this.sortOrder = oldSortOrder;

        var count = 0;
        try {
            select.executeStep();
            count = select.getInt32(0);
        }
        finally {
            select.reset();
        }
        return count;
    },


    // nsIBriefQuery
    markEntriesRead: function BriefQuery_markEntriesRead(aStatus) {

        // Make sure not to select entries which already have the desired status.
        prevUnreadFlag = this.unread;
        prevReadFlag = this.read;
        if (aStatus)
            this.unread = true;
        else
            this.read = true;

        var statement = 'UPDATE entries SET read = ?, updated = 0 ' + this.getQueryText();

        var update = this.dBConnection.createStatement(statement)
        update.bindInt32Parameter(0, aStatus ? 1 : 0);

        this.dBConnection.beginTransaction();
        try {
            // Get the list of entries which we deleted, so we can pass it in the
            // notification. Never include those from hidden feeds though - nobody cares
            // for them and, what's more, they don't expect to deal with them.
            var prevIncludeHiddenFlag = this.includeHiddenFeeds;
            this.includeHiddenFeeds = false;
            var changedEntries = this.getSerializedEntries();
            this.includeHiddenFeeds = prevIncludeHiddenFlag;

            update.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
            this.unread = prevUnreadFlag;
            this.read = prevReadFlag;
        }

        // If any entries were marked, dispatch the notifiaction.
        if (changedEntries.getPropertyAsAString('entries')) {
            this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                                 aStatus ? 'read' : 'unread');
        }
    },


    // nsIBriefQuery
    deleteEntries: function BriefQuery_deleteEntries(aState) {

        var statementString;
        switch (aState) {
            case Ci.nsIBriefQuery.ENTRY_STATE_NORMAL:
            case Ci.nsIBriefQuery.ENTRY_STATE_TRASHED:
            case Ci.nsIBriefQuery.ENTRY_STATE_DELETED:
                statementString = 'UPDATE entries SET deleted = ' + aState +
                                   this.getQueryText();
                break;

            case Ci.nsIBriefQuery.REMOVE_FROM_DATABASE:
                statementString = 'DELETE FROM entries ' + this.getQueryText();
                break;

            default:
                throw('Invalid deleted state.');
        }

        var statement = this.dBConnection.createStatement(statementString)
        this.dBConnection.beginTransaction();
        try {
            // See markEntriesRead.
            var prevIncludeHiddenFlag = this.includeHiddenFeeds;
            this.includeHiddenFeeds = false;
            var changedEntries = this.getSerializedEntries();
            this.includeHiddenFeeds = prevIncludeHiddenFlag;

            statement.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        if (changedEntries.getPropertyAsAString('entries')) {
            this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                                 'deleted');
        }
    },


    // nsIBriefQuery
    starEntries: function BriefQuery_starEntries(aStatus) {
        var statement = 'UPDATE entries SET starred = ? ' + this.getQueryText();
        var update = this.dBConnection.createStatement(statement);
        update.bindInt32Parameter(0, aStatus ? 1 : 0);

        this.dBConnection.beginTransaction();
        try {
            // See markEntriesRead.
            var prevIncludeHiddenFlag = this.includeHiddenFeeds;
            this.includeHiddenFeeds = false;
            var changedEntries = this.getSerializedEntries();
            this.includeHiddenFeeds = prevIncludeHiddenFlag;

            update.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        if (changedEntries.getPropertyAsAString('entries')) {
            this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                                 'starred');
        }
    },


    getQueryText: function BriefQuery_getQueryText(aForSelect) {
        if (aForSelect)
            var text = ' FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID WHERE ';
        else
            var text = ' WHERE entries.rowid IN (SELECT entries.rowid FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID WHERE ';

        if (this.folders) {
            this.effectiveFolders = this.folders.match(/[^ ]+/g);

            // Cache the items list to avoid retrieving it over and over when traversing.
            this._items = Components.classes['@ancestor/brief/storage;1'].
                                     getService(Components.interfaces.nsIBriefStorage).
                                     getFeedsAndFolders({});

            var homeFolder = gStorageService.prefs.getIntPref('homeFolder');

            this.traverseChildren(homeFolder);

            text += '(';
            for (var i = 0; i < this.effectiveFolders.length; i++) {
                text += 'feeds.parent = "' + this.effectiveFolders[i] + '"';
                if (i < this.effectiveFolders.length - 1)
                    text += ' OR ';
            }
            text += ') AND ';
        }

        if (this.feeds) {
            var feeds = this.feeds.match(/[^ ]+/g);

            text += '(';
            for (var i = 0; i < feeds.length; i++) {
                text += 'entries.feedID = "' + feeds[i] + '"';
                if (i < feeds.length - 1)
                    text += ' OR ';
            }
            text += ') AND ';
        }

        if (this.entries) {
            var entries = this.entries.match(/[^ ]+/g);

            text += '(';
            for (var i = 0; i < entries.length; i++) {
                text += 'entries.id = "' + entries[i] + '"';
                if (i < entries.length - 1)
                    text += ' OR ';
            }
            text += ') AND ';
        }

        if (this.searchString) {
            var words = this.searchString.match(/[^ ]+/g);
            for (var i = 0; i < words.length; i++)
                text += '(entries.title LIKE "%" || "' + words[i] + '" || "%" OR entries.content LIKE "%" || "' + words[i] + '" || "%") AND ';
        }

        if (this.read)
            text += 'entries.read = 1 AND ';
        if (this.unread)
            text += 'entries.read = 0 AND ';
        if (this.starred)
            text += 'entries.starred = 1 AND ';
        if (this.unstarred)
            text += 'entries.starred = 0 AND ';

        var nsIBriefQuery = Components.interfaces.nsIBriefQuery;
        if (this.deleted != nsIBriefQuery.ENTRY_STATE_ANY)
            text += 'entries.deleted = ' + this.deleted + ' AND ';

        if (this.startDate > 0)
            text += 'entries.date >= ' + this.startDate + ' AND ';
        if (this.endDate > 0)
            text += 'entries.date <= ' + this.endDate + ' AND ';

        if (!this.includeHiddenFeeds)
            text += 'feeds.hidden = 0 ';

        // Trim the trailing AND, if there is one
        text = text.replace(/AND $/, '');
        // If the were no constraints (all entries are matched),
        // we may end up with a dangling WHERE.
        text = text.replace(/WHERE $/, '');

        if (!aForSelect)
            return text += ') ';

        if (this.sortOrder != nsIBriefQuery.NO_SORT) {

            var sortOrder;
            switch (this.sortOrder) {
            case nsIBriefQuery.SORT_BY_FEED_ROW_INDEX:
                sortOrder = 'feeds.rowIndex ';
                break;
            case nsIBriefQuery.SORT_BY_DATE:
                sortOrder = 'entries.date ';
                break;
            case nsIBriefQuery.SORT_BY_TITLE:
                sortOrder = 'entries.title ';
                break;
            default:
                throw('BriefQuery: wrong sort order, use one the defined constants.');
            }

            var sortDir = this.sortDirection == nsIBriefQuery.SORT_ASCENDING ? 'ASC' : 'DESC';
            text += 'ORDER BY ' + sortOrder + sortDir;
        }

        if (this.limit)
            text += ' LIMIT ' + this.limit;
        if (this.offset > 1)
            text += ' OFFSET ' + this.offset;

        return text;
    },

    getQueryTextForSelect: function BriefQuery_getQueryTextForSelect() {
        return this.getQueryText(true);
    },

    traverseChildren: function BriefQuery_traverseChildren(aFolder) {
        var isEffectiveFolder = this.effectiveFolders.indexOf(aFolder) != -1;
        var item, i;
        for (i = 0; i < this._items.length; i++) {
            item = this._items[i];
            if (item.parent == aFolder && item.isFolder) {
                if (isEffectiveFolder)
                    this.effectiveFolders.push(item.feedID);
                this.traverseChildren(item.feedID);
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
    // XXX nsIStringInputStream doesn't work well with UTF-16 strings; it's
    // lossy, so it increases the risk of collisions.
    // nsIScriptableUnicodeConverter.convertToInputStream should be used instead.
    var stringStream = Cc["@mozilla.org/io/string-input-stream;1"].
                       createInstance(Ci.nsIStringInputStream);
    stringStream.setData(aString, aString.length);

    var hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
    hasher.init(Ci.nsICryptoHash.MD5);
    hasher.updateFromStream(stringStream, stringStream.available());
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

function dump(aMessage) {
  var consoleService = Cc["@mozilla.org/consoleservice;1"].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n' + aMessage);
}


var components = [BriefStorageService, BriefQuery];
function NSGetModule(compMgr, fileSpec) XPCOMUtils.generateModule(components)
