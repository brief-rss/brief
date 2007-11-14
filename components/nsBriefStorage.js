const STORAGE_CLASS_ID = Components.ID('{4C468DA8-7F30-11DB-A690-EBF455D89593}');
const STORAGE_CLASS_NAME = 'mozStorage database component for the Brief extension';
const STORAGE_CONTRACT_ID = '@ancestor/brief/storage;1';

const QUERY_CLASS_ID = Components.ID('{10992573-5d6d-477f-8b13-8b578ad1c95e}');
const QUERY_CLASS_NAME = 'Query to database of the Brief extension';
const QUERY_CONTRACT_ID = '@ancestor/brief/query;1';

const Cc = Components.classes;
const Ci = Components.interfaces;

const NC_NAME     = 'http://home.netscape.com/NC-rdf#Name';
const NC_FEEDURL  = 'http://home.netscape.com/NC-rdf#FeedURL';
const NC_LIVEMARK = 'http://home.netscape.com/NC-rdf#Livemark';
const RDF_TYPE    = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// How often to delete entries that have expired or exceed the max number of entries per feed.
const DELETE_REDUNDANT_ENTRIES_INTERVAL = 3600*24; // 1 day

// How often to permanently remove deleted entries and VACUUM the database.
const PURGE_DELETED_ENTRIES_INTERVAL = 3600*24*3; // 3 days

// How long to keep entries from feeds no longer in the home folder.
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // 1 week

const RDF_OBSERVER_DELAY = 250;

const DATABASE_VERSION = 4;

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
    rdfService:            null,
    bookmarksService:      null,
    rdfContainerUtils:     null,
    bookmarksDataSource:   null,

    rdfObserverDelayTimer: null,
    rdfObserverTimerIsRunning: false,


    instantiate: function BriefStorage_instantiate() {
        var file = Cc['@mozilla.org/file/directory_service;1'].
                   getService(Ci.nsIProperties).
                   get('ProfD', Ci.nsIFile);
        file.append('brief.sqlite');
        var databaseIsNew = !file.exists();

        var storageService = Cc['@mozilla.org/storage/service;1'].
                             getService(Ci.mozIStorageService);
        this.dBConnection = storageService.openDatabase(file);
        this.dummyDBConnection = storageService.openDatabase(file);

        if (databaseIsNew)
            this.dBConnection.executeSimpleSQL('PRAGMA user_version = ' + DATABASE_VERSION);

        //this.dBConnection.executeSimpleSQL('DROP TABLE IF EXISTS feeds');
        //this.dBConnection.executeSimpleSQL('DROP TABLE IF EXISTS entries');

        this.dBConnection.executeSimpleSQL('CREATE TABLE IF NOT EXISTS feeds (    ' +
                                           'feedID         TEXT UNIQUE,           ' +
                                           'RDF_URI        TEXT,                  ' +
                                           'feedURL        TEXT,                  ' +
                                           'websiteURL     TEXT,                  ' +
                                           'title          TEXT,                  ' +
                                           'subtitle       TEXT,                  ' +
                                           'imageURL       TEXT,                  ' +
                                           'imageLink      TEXT,                  ' +
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

        this.startDummyStatement();
        this.dBConnection.preload();

        this.prefs = Cc["@mozilla.org/preferences-service;1"].
                     getService(Ci.nsIPrefService).
                     getBranch('extensions.brief.').
                     QueryInterface(Ci.nsIPrefBranch2);
        this.prefs.addObserver('', this, false);

        this.initBookmarks();

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

            // 0.8 changed how IDs are generated. Below we recompute IDs, but we doesn't
            // need to do it for entries which are no longer available in the feed.
            var selectRecentEntries = this.dBConnection.createStatement(
                'SELECT entries.feedID, entries.entryURL, entries.providedID, entries.id ' +
                'FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID          ' +
                'WHERE entries.date >= feeds.oldestAvailableEntryDate                    ');

            var updateEntryIDs = this.dBConnection.createStatement(
                'UPDATE OR IGNORE entries SET id = ?1, secondaryID = ?2 WHERE id = ?3');

            // Brief isn't likely to ever make use of storing both content field
            // and summary field, so we may as well abandon the |summary| column.
            // In the |content| column we will store either the content or when
            // content is unavailable - the summary.
            // To migrate to the new system, we need populate empty |content| columns
            // with |summary| columns.
            var updateEntryContent = this.dBConnection.createStatement(
                'UPDATE entries SET content = summary, summary = "" WHERE content = ""');

            var entries = [], entry, newID, newSecondaryID;
            this.dBConnection.beginTransaction();

            try {
                while (selectRecentEntries.executeStep()) {
                    entry = {};
                    entry.feedID = selectRecentEntries.getString(0);
                    entry.entryURL = selectRecentEntries.getString(1);
                    entry.providedID = selectRecentEntries.getString(2);
                    entry.id = selectRecentEntries.getString(3);
                    entries.push(entry);
                }
                selectRecentEntries.reset();

                for each (entry in entries) {
                    newID = hashString(entry.feedID + entry.entryURL + entry.providedID);
                    newSecondaryID = hashString(entry.feedID + entry.entryURL);

                    updateEntryIDs.bindStringParameter(0, newID);
                    updateEntryIDs.bindStringParameter(1, newSecondaryID);
                    updateEntryIDs.bindStringParameter(2, entry.id);
                    updateEntryIDs.execute();
                }

                updateEntryContent.execute();
            }
            catch (e) {
                this.logDatabaseError(e);
            }
            finally {
                this.dBConnection.commitTransaction();
            }
            // Fall through...

        // To 1.0 beta 1
        case 2:
            this.dBConnection.executeSimpleSQL(
                              'ALTER TABLE entries ADD COLUMN updated INTEGER DEFAULT 0');
            // Fall through...

        // To 1.0
        case 3:
            this.dBConnection.executeSimpleSQL('DROP INDEX entries_id_index');
            this.dBConnection.executeSimpleSQL('DROP INDEX feeds_feedID_index');
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
                feed.rdf_uri = select.getString(14);
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
        var now = Date.now();
        var oldestEntryDate = now;

        var insertEntry = this.dBConnection.createStatement(
                          'INSERT OR IGNORE INTO entries                         ' +
                          '(                                                     ' +
                          'feedID, id, secondaryID, providedID, entryURL,        ' +
                          'title,  content, date, authors, read                  ' +
                          ')                                                     ' +
                          'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)      ');
        var updateEntry = this.dBConnection.createStatement(
                          'UPDATE entries       ' +
                          'SET content = ?1,    ' +
                          '    date    = ?2,    ' +
                          '    authors = ?3,    ' +
                          '    read    = 0,     ' +
                          '    updated = 1      ' +
                          'WHERE id = ?4        ');
        var getDateForEntry = this.dBConnection.
                              createStatement('SELECT date FROM entries WHERE id = ?');

        this.dBConnection.beginTransaction();

        // Count the unread entries, to compare their number later.
        var unreadEntriesQuery = Cc['@ancestor/brief/query;1'].
                                 createInstance(Ci.nsIBriefQuery);
        unreadEntriesQuery.setConditions(aFeed.feedID, null, true);
        var oldUnreadCount = unreadEntriesQuery.getEntriesCount();

        var isMediaWikiFeed = aFeed.wrappedFeed.generator &&
                              aFeed.wrappedFeed.generator.agent.match('MediaWiki');

        try {
            var entries = aFeed.getEntries({});
            var entry, title, storedEntryDate, primaryID, secondaryID, entryAlreadyStored,
                entryURL, authors;

            // Generate hashes, insert and update entries.
            for (var i = 0; i < entries.length; i++) {
                entry = entries[i];
                entryAlreadyStored = false;

                content = entry.content || entry.summary;

                // Strip tags
                title = entry.title ? entry.title.replace(/<[^>]+>/g, '') : '';

                // All file:// URIs are treated as same-origin which would let a script
                // running in our template a page access local files using XHR.
                content = content ? content.replace(/XMLHttpRequest/g, 'XMLHTTPRequest') : '';
                entryURL = entry.entryURL ? entry.entryURL.replace(/XMLHttpRequest/g, 'XMLHTTPRequest') : '';
                authors = entry.authors ? entry.authors.replace(/XMLHttpRequest/g, 'XMLHTTPRequest') : '';

                // Compute the hash which serves as the entry's unique id.
                // Special case for MediaWiki feeds: include the date in the hash. In
                // "Recent changes" feeds, entries for subsequent edits of a page
                // differ only in date (not in URL or GUID).
                // Sometimes the provided GUID is lost (maybe a bug in the parser?) and
                // having an empty GUID effects in a different hash which leads to
                // annoying duplication of entries. We work around it by having
                // a secondary hash, computed without the GUID, and using it when
                // GUID is blank to check if entry exists (see below).
                if (isMediaWikiFeed) {
                    primaryID = hashString(aFeed.feedID + entry.entryURL + entry.id + entry.date);
                    secondaryID = hashString(aFeed.feedID + entry.entryURL + entry.date);
                }
                else {
                    primaryID = hashString(aFeed.feedID + entry.entryURL + entry.id);
                    secondaryID = hashString(aFeed.feedID + entry.entryURL);
                }

                // If GUID is blank, manually check for entry's existance using the
                // secondaryID. This makes no difference for feeds which don't
                // supply GUIDs at all and circumvents the problem of when a feed
                // does usually supply GUIDs but one of them gets lost during a
                // particular update.
                if (!entry.id) {
                    var checkEntryBySecondaryID = this.dBConnection.createStatement(
                        'SELECT secondaryID FROM entries WHERE secondaryID = ?');
                    checkEntryBySecondaryID.bindStringParameter(0, secondaryID);
                    entryAlreadyStored = checkEntryBySecondaryID.executeStep();
                    checkEntryBySecondaryID.reset();
                }

                // See if this entry is already in the database while getting its date.
                storedEntryDate = null;
                getDateForEntry.bindStringParameter(0, primaryID);
                if (getDateForEntry.executeStep())
                    storedEntryDate = getDateForEntry.getInt64(0);
                getDateForEntry.reset();

                // If the entry is already present in the database, compare if the
                // downloaded entry has a newer date than the stored one and if so,
                // update the data and mark the entry as unread.
                // Otherwise, insert it if it isn't present yet.
                if (storedEntryDate !== null && entry.date && storedEntryDate < entry.date) {
                    updateEntry.bindStringParameter(0, content);
                    updateEntry.bindInt64Parameter(1, entry.date)
                    updateEntry.bindStringParameter(2, authors);
                    updateEntry.bindStringParameter(3, primaryID);

                    updateEntry.execute();
                }
                else if (!entryAlreadyStored) {
                    insertEntry.bindStringParameter(0, aFeed.feedID);
                    insertEntry.bindStringParameter(1, primaryID);
                    insertEntry.bindStringParameter(2, secondaryID);
                    insertEntry.bindStringParameter(3, entry.id);
                    insertEntry.bindStringParameter(4, entryURL);
                    insertEntry.bindStringParameter(5, title);
                    insertEntry.bindStringParameter(6, content);
                    insertEntry.bindInt64Parameter(7, entry.date ? entry.date : now);
                    insertEntry.bindStringParameter(8, authors);
                    insertEntry.bindInt32Parameter(9, 0);

                    insertEntry.execute();
                }

                // Track the date of the oldest entry.
                if (entry.date && entry.date < oldestEntryDate)
                    oldestEntryDate = entry.date;
            }

            // Update the feed's data. Do not update the title, though, because it's
            // taken from the Live Bookmark.
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
            updateFeed.bindInt64Parameter(6,  oldestEntryDate);
            updateFeed.bindInt64Parameter(7,  now);
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
            cachedFeed.lastUpdated = now;
            cachedFeed.oldestAvailableEntryDate = oldestEntryDate;
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


    // Deletes entries that are outdated or exceed the max number per feed based.
    deleteRedundantEntries: function BriefStorage_deleteRedundantEntries() {
        var expireEntriesGlobal = this.prefs.getBoolPref('database.expireEntries');
        var useGlobalStoreLimit = this.prefs.getBoolPref('database.limitStoredEntries');
        var globalExpirationAge = this.prefs.getIntPref('database.entryExpirationAge');
        var globalMaxEntries = this.prefs.getIntPref('database.maxStoredEntries');

        // globalExpirationAge is in days, convert it to miliseconds
        var globalEdgeDate = Date.now() - globalExpirationAge * 86400000;
        var feeds = this.getAllFeeds({});

        var deleteOutdatedGlobal = this.dBConnection.createStatement(
            'UPDATE entries SET deleted = 2                                    ' +
            'WHERE id IN                                                       ' +
            '(                                                                 ' +
            '   SELECT entries.id                                              ' +
            '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
            '   WHERE feeds.entryAgeLimit = 0 AND entries.starred = 0 AND      ' +
            '         entries.date < ?                                         ' +
            ')                                                                 ');

        var deleteOutdatedPerFeed = this.dBConnection.createStatement(
            'UPDATE entries SET deleted = 2                          ' +
            'WHERE feedID = ? AND starred = 0 AND entries.date < ?   ');

        var deleteExcessive = this.dBConnection.createStatement(
            'UPDATE entries SET deleted = 2                        ' +
            'WHERE id IN                                           ' +
            '(                                                     ' +
            '    SELECT id                                         ' +
            '    FROM entries                                      ' +
            '    WHERE starred = 0 AND feedID = ?                  ' +
            '    ORDER BY date ASC                                 ' +
            '    LIMIT ?                                           ' +
            ')                                                     ');

        var getEntriesCountForFeed = this.dBConnection.createStatement(
            'SELECT COUNT(1) FROM entries WHERE starred = 0 AND feedID = ? ');

        this.dBConnection.beginTransaction();
        try {
            // Delete outdated entries in feeds that don't have per-feed setting enabled.
            if (expireEntriesGlobal) {
                deleteOutdatedGlobal.bindInt64Parameter(0, globalEdgeDate);
                deleteOutdatedGlobal.execute();
            }

            // Delete entries exceeding the max number. We have to do it feed by feed.
            var entryCount, difference, i;
            for (i = 0; i < feeds.length; i++) {
                // Count the number of entries in the feed.
                getEntriesCountForFeed.bindStringParameter(0, feeds[i].feedID);
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
                    deleteExcessive.bindStringParameter(0, feeds[i].feedID);
                    deleteExcessive.bindInt64Parameter(1, difference);
                    deleteExcessive.execute();
                }
            }

            // Delete outdated entries based on the per-feed limit.
            var edgeDate, i;
            for (i = 0; i < feeds.length; i++) {
                if (feeds[i].entryAgeLimit > 0) {
                    edgeDate = Date.now() - feeds[i].entryAgeLimit * 86400000;
                    deleteOutdatedPerFeed.bindStringParameter(0, feeds[i].feedID);
                    deleteOutdatedPerFeed.bindInt64Parameter(1, edgeDate);
                    deleteOutdatedPerFeed.execute();
                }
            }
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        // Prefs can only store longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        this.prefs.setIntPref('database.lastDeletedRedundantTime', now);
    },


    // Permanently remove the deleted entries from database and VACUUM it. Should only
    // be run on shutdown.
    purgeDeletedEntries: function BriefStorage_purgeDeletedEntries() {
        var removeEntries = this.dBConnection.createStatement(
            'DELETE FROM entries                                                              ' +
            'WHERE id IN                                                                      ' +
            '(                                                                                ' +
            '   SELECT entries.id                                                             ' +
            '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID                ' +
            '   WHERE (entries.deleted = 2 AND feeds.oldestAvailableEntryDate > entries.date) ' +
            '         OR (? - feeds.hidden > ? AND feeds.hidden != 0)                         ' +
            ')                                                                                ');
        removeEntries.bindInt64Parameter(0, Date.now());
        removeEntries.bindInt64Parameter(1, DELETED_FEEDS_RETENTION_TIME);
        removeEntries.execute();

        var removeFeeds = this.dBConnection.createStatement(
            'DELETE FROM feeds WHERE (? - feeds.hidden > ?) AND feeds.hidden != 0');
        removeFeeds.bindInt64Parameter(0, Date.now());
        removeFeeds.bindInt64Parameter(1, DELETED_FEEDS_RETENTION_TIME);
        removeFeeds.execute();

        // Prefs can only store longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        this.prefs.setIntPref('database.lastPurgeTime', now);

        var vacuumDisabled = this.prefs.getBoolPref('database.disableCompacting');
        if (!vacuumDisabled) {
            this.stopDummyStatement();
            this.dBConnection.executeSimpleSQL('VACUUM');
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

                var lastTime = this.prefs.getIntPref('database.lastDeletedRedundantTime');
                if (now - lastTime > DELETE_REDUNDANT_ENTRIES_INTERVAL)
                    this.deleteRedundantEntries();

                lastTime = this.prefs.getIntPref('database.lastPurgeTime');
                if (now - lastTime > PURGE_DELETED_ENTRIES_INTERVAL)
                    this.purgeDeletedEntries();

                this.bookmarksDataSource.RemoveObserver(this);
                this.prefs.removeObserver('', this);
                this.observerService.removeObserver(this, 'quit-application');
                this.observerService.removeObserver(this, 'profile-after-change');
                break;

            case 'timer-callback':
                this.rdfObserverTimerIsRunning = false;
                this.syncWithBookmarks();
                break;

            case 'nsPref:changed':
                switch (aData) {
                    case 'liveBookmarksFolder':
                        this.syncWithBookmarks();
                        break;
                }
                break;
        }
    },


    // nsIBriefStorage
    syncWithBookmarks: function BriefStorage_syncWithBookmarks() {
        this.bookmarkItems = [];

        // Get the current Live Bookmarks
        this.rootURI = this.prefs.getCharPref('liveBookmarksFolder');
        if (!this.rootURI) {
            this.dBConnection.executeSimpleSQL('UPDATE feeds SET hidden = 1');
            this.observerService.notifyObservers(null, 'brief:invalidate-feedlist', '');
            return;
        }

        root = this.rdfService.GetResource(this.rootURI);
        try {
            this.traverseLivemarks(root);
        }
        catch (e) {
            // Traversing will throw if root folder was removed.
        }

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
                feed.rdf_uri = selectAll.getString(5);
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
                    insertItem.bindStringParameter(6, item.uri);
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
                       item.title != feed.title || item.uri != feed.rdf_uri || feed.hidden > 0) {

                        // Invalidate cache since feeds table is about to change.
                        this.feedsCache = this.feedsAndFoldersCache = null;

                        updateFeed.bindStringParameter(0, item.title);
                        updateFeed.bindInt32Parameter(1, item.rowIndex);
                        updateFeed.bindStringParameter(2, item.parent);
                        updateFeed.bindStringParameter(3, item.uri);
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


    // Initializes RDF services and resources.
    initBookmarks: function BriefStorage_initLivemarks() {
        this.rdfService = Cc['@mozilla.org/rdf/rdf-service;1'].
                          getService(Ci.nsIRDFService);
        this.bookmarksDataSource = this.rdfService.GetDataSource('rdf:bookmarks');
        this.bookmarksDataSource.AddObserver(this);

        this.bookmarksService = this.bookmarksDataSource.
                                     QueryInterface(Ci.nsIBookmarksService);
        this.rdfContainerUtils = Cc['@mozilla.org/rdf/container-utils;1'].
                                 getService(Ci.nsIRDFContainerUtils);

        this.rdfObserverDelayTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);

        // Predicates
        this.typeArc = this.rdfService.GetResource(RDF_TYPE);
        this.nameArc = this.rdfService.GetResource(NC_NAME);
        this.feedUrlArc = this.rdfService.GetResource(NC_FEEDURL);

        // Common targets
        this.livemarkType = this.rdfService.GetResource(NC_LIVEMARK);
    },


    /**
     * Recursively reads livemarks and folders and stores them in the |bookmarkItems|
     * array.
     *
     * @param  aFolder  An RDF resource - the folder to be traversed.
     */
     traverseLivemarks: function BriefStorage_traverseLivemarks(aFolder) {

        var folderURI = aFolder.QueryInterface(Ci.nsIRDFResource).Value;
        var folderFeedID = hashString(folderURI);

        var container = Cc['@mozilla.org/rdf/container;1'].
                        createInstance(Ci.nsIRDFContainer);
        container.Init(this.bookmarksDataSource, aFolder);
        var children = container.GetElements();

        var child, type, item, uri;
        while (children.hasMoreElements()) {

            child = children.getNext();
            type = this.bookmarksDataSource.GetTarget(child, this.typeArc, true);

            // The child is a Live Bookmark.
            if (type == this.livemarkType) {
                item = {};
                item.feedURL = this.bookmarksDataSource.GetTarget(child, this.feedUrlArc, true).
                                                        QueryInterface(Ci.nsIRDFLiteral).
                                                        Value;
                item.feedID = hashString(item.feedURL);
                item.uri = child.QueryInterface(Ci.nsIRDFResource).Value;
                item.title = this.bookmarksDataSource.GetTarget(child, this.nameArc, true).
                                                      QueryInterface(Ci.nsIRDFLiteral).
                                                      Value;
                item.rowIndex = this.bookmarkItems.length;
                item.isFolder = false;
                item.parent = folderFeedID;

                this.bookmarkItems.push(item);
            }

            // The child is a folder.
            else if (this.rdfContainerUtils.IsSeq(this.bookmarksDataSource, child)) {
                item = {};
                item.title = this.bookmarksDataSource.GetTarget(child, this.nameArc, true).
                                                      QueryInterface(Ci.nsIRDFLiteral).
                                                      Value;
                item.uri = child.QueryInterface(Ci.nsIRDFResource).Value;
                item.feedID = hashString(item.uri);
                item.rowIndex = this.bookmarkItems.length;
                item.isFolder = true;
                item.parent = folderFeedID;

                this.bookmarkItems.push(item);

                // Recurse...
                this.traverseLivemarks(child);
            }
        }
    },


    onAssert: function BriefStorage_onAssert(aDataSource, aSource, aProperty, aTarget) {

        // Because we only care about livemarks and folders, check if the assertion
        // target is even a resource, for optimization.
        if (!(aTarget instanceof Ci.nsIRDFResource))
            return;

        // Check if the target item is an RDF sequence (i.e. livemark or folder) and if
        // it is in the home folder.
        var isFolder = this.rdfContainerUtils.IsSeq(this.bookmarksDataSource, aTarget);
        if (isFolder && this.resourceIsInHomeFolder(aTarget))
            this.delayedBookmarksSync();
    },

    onUnassert: function BriefStorage_onUnassert(aDataSource, aSource, aProperty, aTarget) {

        if (!(aTarget instanceof Ci.nsIRDFResource) ||
           !this.rdfContainerUtils.IsSeq(this.bookmarksDataSource, aTarget)) {
            return;
        }

        var homeFolderURI = this.prefs.getCharPref('liveBookmarksFolder');

        // We need to check if the home folder is in the removed item's (i.e. the
        // assertion target's) parent chain. Because the target is already detached and
        // has no parent, we need to examine the parent chain of the assertion source
        // instead. But the source itself can be the home folder, so let's check that, too.
        if (aSource.Value == homeFolderURI || this.resourceIsInHomeFolder(aSource))
            this.delayedBookmarksSync();
    },

    onChange: function BriefStorage_onChange(aDataSource, aSource, aProperty, aOldTarget,
                                             aNewTarget) {

        if ((aProperty == this.nameArc || aProperty == this.feedUrlArc) &&
           this.resourceIsInHomeFolder(aSource)) {
            this.delayedBookmarksSync();
        }

    },

    onEndUpdateBatch: function BriefStorage_onEndUpdateBatch(aDataSource) {
        this.delayedBookmarksSync();
    },

    onMove: function BriefStorage_onMove(aDataSource, aOldSource, aNewSource, aProperty, aTarget) { },
    onBeginUpdateBatch: function BriefStorage_onBeginUpdateBatch(aDataSource) { },

    resourceIsInHomeFolder: function BriefStorage_resourceIsInHomeFolder(aResource) {
        var homeFolderURI = this.prefs.getCharPref('liveBookmarksFolder');

        var parentChain = this.bookmarksService.getParentChain(aResource);
        var length = parentChain.length;
        for (var i = 0; i < length; i++) {
            var node = parentChain.queryElementAt(i, Ci.nsIRDFResource);
            if (node.Value == homeFolderURI)
                return true;
        }

        return false;
    },

    delayedBookmarksSync: function BriefStorage_delayedBookmarksSync() {
        if (this.rdfObserverTimerIsRunning)
            this.rdfObserverDelayTimer.cancel();

        this.rdfObserverDelayTimer.init(this, RDF_OBSERVER_DELAY, Ci.nsITimer.TYPE_ONE_SHOT);
        this.rdfObserverTimerIsRunning = true;
    },


    /**
     * Adopted from nsNavHistory::StartDummyStatement.
     *
     * sqlite page caches are discarded when a statement is complete. To get
     * around this, we keep a different connection. This dummy connection has a
     * statement that stays open and thus keeps its pager cache in memory. When
     * the shared pager cache is enabled before either connection has been opened
     * (this is done by the storage service on DB init), our main connection
     * will get the same pager cache, which will be persisted.
     *
     * When a statement is open on a database, it is disallowed to change the
     * schema of the database (add or modify tables or indices).
     */
    startDummyStatement: function BriefStorage_startDummyStatement() {
        // Make sure the dummy table exists.
        this.dBConnection.executeSimpleSQL(
                       'CREATE TABLE IF NOT EXISTS dummy_table (id INTEGER PRIMARY KEY)');

        // This table is guaranteed to have something in it and will keep the dummy
        // statement open. If the table is empty, it won't hold the statement open.
        this.dBConnection.executeSimpleSQL('INSERT OR IGNORE INTO dummy_table VALUES (1)');

        this.dummyStatement = this.dummyDBConnection.
                                   createStatement('SELECT id FROM dummy_table LIMIT 1');

        // We have to step the dummy statement so that it will hold a lock on the DB.
        this.dummyStatement.executeStep();
    },


    stopDummyStatement: function BriefStorage_stopDummyStatement() {
        // Do nothing if the dummy statement isn't running.
        if (!this.dummyStatement)
            return;

        this.dummyStatement.reset();
        this.dummyStatement = null;
    },


    logDatabaseError: function BriefStorage_logDatabaseError(aException) {
        var error = this.dBConnection.lastErrorString;
        var consoleService = Cc['@mozilla.org/consoleservice;1'].
                             getService(Ci.nsIConsoleService);
        consoleService.logStringMessage('Brief database error:\n ' + error + '\n\n ' +
                                        aException);
    },


    // nsISupports
    QueryInterface: function BriefStorage_QueryInterface(aIID) {
        if (!aIID.equals(Components.interfaces.nsIBriefStorage) &&
            !aIID.equals(Components.interfaces.nsIObserver) &&
            !aIID.equals(Components.interfaces.nsIRDFObserver) &&
            !aIID.equals(Components.interfaces.nsISupports)) {
            throw Components.results.NS_ERROR_NO_INTERFACE;
        }
        return this;
    }

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
            var changedEntries = this.getSerializedEntries(this);
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
            var changedEntries = this.getSerializedEntries(this);
            this.includeHiddenFeeds = prevIncludeHiddenFlag;

            statement.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                             'deleted');
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
            var changedEntries = this.getSerializedEntries(this);
            this.includeHiddenFeeds = prevIncludeHiddenFlag;

            update.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                             'starred');
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
            var rootFolderURI = Cc["@mozilla.org/preferences-service;1"].
                                getService(Ci.nsIPrefBranch).
                                getCharPref('extensions.brief.liveBookmarksFolder');
            this.traverseChildren(hashString(rootFolderURI));

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

    // nsISupports
    QueryInterface: function BriefQuery_QueryInterface(aIID) {
        if (!aIID.equals(Components.interfaces.nsIBriefQuery) &&
           !aIID.equals(Components.interfaces.nsISupports)) {
            throw Components.results.NS_ERROR_NO_INTERFACE;
        }
        return this;
    }

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


var StorageServiceFactory = {

    createInstance: function(aOuter, aIID) {
        if (aOuter != null)
            throw Components.results.NS_ERROR_NO_AGGREGATION;

        if (!gStorageService)
            gStorageService = new BriefStorageService();

        return gStorageService.QueryInterface(aIID);
    }

}

var QueryFactory = {

    createInstance: function(aOuter, aIID) {
        if (aOuter != null)
            throw Components.results.NS_ERROR_NO_AGGREGATION;

        return (new BriefQuery()).QueryInterface(aIID);
    }

}

// module definition (xpcom registration)
var Module = {
    _firstTime: true,

    registerSelf: function(aCompMgr, aFileSpec, aLocation, aType) {
        aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
        aCompMgr.registerFactoryLocation(STORAGE_CLASS_ID, STORAGE_CLASS_NAME,
                                         STORAGE_CONTRACT_ID, aFileSpec, aLocation, aType);
        aCompMgr.registerFactoryLocation(QUERY_CLASS_ID, QUERY_CLASS_NAME,
                                         QUERY_CONTRACT_ID, aFileSpec, aLocation, aType);

        var categoryManager = Components.classes['@mozilla.org/categorymanager;1'].
                              getService(Components.interfaces.nsICategoryManager);
        categoryManager.addCategoryEntry('app-startup', 'nsIBriefStorage',
                                         STORAGE_CONTRACT_ID, true, true);
    },

    unregisterSelf: function(aCompMgr, aLocation, aType) {
        aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
        aCompMgr.unregisterFactoryLocation(CLASS_ID, aLocation);

        var categoryManager = Components.classes['@mozilla.org/categorymanager;1'].
                              getService(Components.interfaces.nsICategoryManager);
        categoryManager.deleteCategoryEntry('app-startup', 'nsIBriefStorage', true);
    },

    getClassObject: function(aCompMgr, aCID, aIID) {
        if (!aIID.equals(Components.interfaces.nsIFactory))
            throw Components.results.NS_ERROR_NOT_IMPLEMENTED;

        if (aCID.equals(STORAGE_CLASS_ID))
            return StorageServiceFactory;
        if (aCID.equals(QUERY_CLASS_ID))
            return QueryFactory;

        throw Components.results.NS_ERROR_NO_INTERFACE;
    },

    canUnload: function(aCompMgr) { return true; }

}

// module initialization
function NSGetModule(aCompMgr, aFileSpec) { return Module; }
