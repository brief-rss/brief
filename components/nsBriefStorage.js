const STORAGE_CLASS_ID = Components.ID('{4C468DA8-7F30-11DB-A690-EBF455D89593}');
const STORAGE_CLASS_NAME = 'mozStorage database component for the Brief extension';
const STORAGE_CONTRACT_ID = '@ancestor/brief/storage;1';

const QUERY_CLASS_ID = Components.ID('{10992573-5d6d-477f-8b13-8b578ad1c95e}');
const QUERY_CLASS_NAME = 'Query to database of the Brief extension';
const QUERY_CONTRACT_ID = '@ancestor/brief/query;1';

const Cc = Components.classes;
const Ci = Components.interfaces;

const NC_NAME          = 'http://home.netscape.com/NC-rdf#Name';
const NC_FEEDURL       = 'http://home.netscape.com/NC-rdf#FeedURL';
const NC_LIVEMARK      = 'http://home.netscape.com/NC-rdf#Livemark';
const RDF_NEXT_VAL     = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nextVal';
const RDF_INSTANCE_OF  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#instanceOf';
const RDF_SEQ_INSTANCE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#Seq';
const RDF_SEQ          = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#_';
const RDF_TYPE         = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// How often to delete entries that have expired or exceed the max number of entries per feed.
const DELETE_REDUNDANT_INTERVAL = 3600*24; // 1 day
// How often to permanently remove deleted entries and VACUUM the database.
const PURGE_DELETED_ENTRIES_INTERVAL = 3600*24*3; // 3 days
// How long to keep entries from feeds no longer in the home folder.
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7; // One week


function dump(aMessage) {
  var consoleService = Cc["@mozilla.org/consoleservice;1"].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n' + aMessage);
}

function BriefStorageService() {
    var file = Cc['@mozilla.org/file/directory_service;1'].
               getService(Ci.nsIProperties).
               get('ProfD', Ci.nsIFile);
    file.append('brief.sqlite');

    var storageService = Cc['@mozilla.org/storage/service;1'].
                         getService(Ci.mozIStorageService);
    this.dBConnection = storageService.openDatabase(file);
    this.dummyDBConnection = storageService.openDatabase(file);

    //this.dBConnection.executeSimpleSQL('DROP TABLE IF EXISTS feeds');
    //this.dBConnection.executeSimpleSQL('DROP TABLE IF EXISTS entries');

    this.dBConnection.executeSimpleSQL('CREATE TABLE IF NOT EXISTS feeds ( ' +
                                       'feedID      TEXT UNIQUE,           ' +
                                       'RDF_URI     TEXT,                  ' +
                                       'feedURL     TEXT,                  ' +
                                       'websiteURL  TEXT,                  ' +
                                       'title       TEXT,                  ' +
                                       'subtitle    TEXT,                  ' +
                                       'imageURL    TEXT,                  ' +
                                       'imageLink   TEXT,                  ' +
                                       'imageTitle  TEXT,                  ' +
                                       'favicon     TEXT,                  ' +
                                       'hidden      INTEGER DEFAULT 0,     ' +
                                       'everUpdated INTEGER DEFAULT 0,     ' +
                                       'oldestAvailableEntryDate INTEGER,  ' +
                                       'rowIndex    INTEGER,               ' +
                                       'parent      TEXT,                  ' +
                                       'isFolder    INTEGER                ' +
                                       ')');
    this.dBConnection.executeSimpleSQL('CREATE TABLE IF NOT EXISTS entries (' +
                                       'feedID     TEXT,                    ' +
                                       'id         TEXT UNIQUE,             ' +
                                       'providedId TEXT,                    ' +
                                       'entryURL   TEXT,                    ' +
                                       'title      TEXT,                    ' +
                                       'summary    TEXT,                    ' +
                                       'content    TEXT,                    ' +
                                       'date       INTEGER,                 ' +
                                       'read       INTEGER DEFAULT 0,       ' +
                                       'starred    INTEGER DEFAULT 0,       ' +
                                       'deleted    INTEGER DEFAULT 0        ' +
                                       ')');
    // Columns added in 0.6.
    try {
        this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN    ' +
                                           'oldestAvailableEntryDate INTEGER');
        this.dBConnection.executeSimpleSQL('ALTER TABLE entries ADD COLUMN providedId TEXT');
    }
    catch (e) {}

    // Columns added in 0.7.
    try {
        this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN rowIndex INTEGER');
        this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN parent TEXT');
        this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN isFolder INTEGER');
        this.dBConnection.executeSimpleSQL('ALTER TABLE feeds ADD COLUMN RDF_URI TEXT');
    }
    catch (e) {}

    this.dBConnection.executeSimpleSQL('CREATE UNIQUE INDEX IF NOT EXISTS       ' +
                                       'entries_id_index ON entries (id)        ');
    this.dBConnection.executeSimpleSQL('CREATE INDEX IF NOT EXISTS              ' +
                                       'entries_feedID_index ON entries (feedID)');
    this.dBConnection.executeSimpleSQL('CREATE INDEX IF NOT EXISTS              ' +
                                       'entries_date_index ON entries (date)    ');
    this.dBConnection.executeSimpleSQL('CREATE INDEX IF NOT EXISTS              ' +
                                       'entries_read_index ON entries (read)    ');

    this.startDummyStatement();
    this.dBConnection.preload();

    this.observerService = Cc['@mozilla.org/observer-service;1'].
                           getService(Ci.nsIObserverService);
    this.observerService.addObserver(this, 'quit-application', null);
    this.prefs = Cc["@mozilla.org/preferences-service;1"].
                 getService(Ci.nsIPrefService).
                 getBranch('extensions.brief.').
                 QueryInterface(Ci.nsIPrefBranch2);
    this.prefs.addObserver('', this, false);
}

BriefStorageService.prototype = {

    observerService:      null,
    prefs:                null,
    dBConnection:         null,
    feedsAndFoldersCache: null,
    feedsCache:           null,

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
            createStatement('SELECT                                          ' +
                            'feedID, feedURL, websiteURL, title,             ' +
                            'subtitle, imageURL, imageLink, imageTitle,      ' +
                            'favicon, everUpdated, oldestAvailableEntryDate, ' +
                            'rowIndex, parent, isFolder, RDF_URI             ' +
                            'FROM feeds                                      ' +
                            'WHERE hidden=0 ORDER BY rowIndex ASC            ');
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
                feed.everUpdated = select.getInt32(9);
                feed.oldestAvailableEntryDate = select.getInt64(10);
                feed.rowIndex = select.getInt32(11);
                feed.parent = select.getString(12);
                feed.isFolder = select.getInt32(13) == 1;
                feed.rdf_uri = select.getString(14);

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
    getEntries: function BriefStorage_getEntries(aQuery, entryCount) {
        var statement = 'SELECT                                                         ' +
                        'entries.id,    entries.feedID,  entries.entryURL,              ' +
                        'entries.title, entries.summary, entries.content,               ' +
                        'entries.date,  entries.read,    entries.starred                ' +
                        'FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
                         aQuery.getQueryTextForSelect();

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
                entry.summary = select.getString(4);
                entry.content = select.getString(5);
                entry.date = select.getInt64(6);
                entry.read = (select.getInt32(7) == 1);
                entry.starred = (select.getInt32(8) == 1);

                entries.push(entry);
            }
        }
        finally {
            select.reset();
        }
        entryCount.value = entries.length;
        return entries;
    },


    // nsIBriefStorage
    getSerializedEntries: function BriefStorage_getSerializedEntries(aQuery) {
        var statement = 'SELECT entries.id, entries.feedID FROM                    ' +
                        'entries INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
                         aQuery.getQueryTextForSelect();

        var select = this.dBConnection.createStatement(statement);

        var entries = '';
        var feeds = '';
        try {
            while (select.executeStep()) {
                entries += select.getString(0) + ' ';

                var feedID = select.getString(1);
                if (!feeds.match(feedID))
                    feeds += feedID + ' ';
            }
        }
        finally {
            select.reset();
        }

        var bag = Cc['@mozilla.org/hash-property-bag;1'].
                  createInstance(Ci.nsIWritablePropertyBag2);
        bag.setPropertyAsAString('entries', entries);
        bag.setPropertyAsAString('feeds', feeds);

        return bag;
    },


    // nsIBriefStorage
    getEntriesCount: function BriefStorage_getEntriesCount(aQuery) {
        var statement = 'SELECT COUNT(1) FROM entries                      ' +
                        'INNER JOIN feeds ON entries.feedID = feeds.feedID ' +
                         aQuery.getQueryTextForSelect();
        var select = this.dBConnection.createStatement(statement);

        var count = 0;
        try {
            select.executeStep();
            var count = select.getInt32(0);
        }
        finally {
            select.reset();
        }
        return count;
    },


    // nsIBriefStorage
    updateFeed: function BriefStorage_updateFeed(aFeed) {
        // Invalidate cache since feeds table is about to change.
        this.feedsCache = this.feedsAndFoldersCache = null;

        var now = Date.now();
        var oldestEntryDate = now;

        var insertIntoEntries = this.dBConnection.
            createStatement('INSERT OR IGNORE INTO entries (            ' +
                            'feedID,                                    ' +
                            'id,                                        ' +
                            'providedId,                                ' +
                            'entryURL,                                  ' +
                            'title,                                     ' +
                            'summary,                                   ' +
                            'content,                                   ' +
                            'date,                                      ' +
                            'read)                                      ' +
                            'VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ');
        this.dBConnection.beginTransaction();
        var unreadEntriesQuery = Cc['@ancestor/brief/query;1'].
                                 createInstance(Ci.nsIBriefQuery);
        unreadEntriesQuery.setConditions(aFeed.feedID, null, true);
        var prevUnreadCount = this.getEntriesCount(unreadEntriesQuery);
        try {
            for each (entry in aFeed.getEntries({})) {
                var title = entry.title.replace(/<[^>]+>/g,''); // Strip tags
                var hash = this.hashString(aFeed.feedID + entry.entryURL + entry.id + title);

                insertIntoEntries.bindStringParameter(0, aFeed.feedID);
                insertIntoEntries.bindStringParameter(1, hash);
                insertIntoEntries.bindStringParameter(2, entry.id);
                insertIntoEntries.bindStringParameter(3, entry.entryURL);
                insertIntoEntries.bindStringParameter(4, title);
                insertIntoEntries.bindStringParameter(5, entry.summary);
                insertIntoEntries.bindStringParameter(6, entry.content);
                insertIntoEntries.bindInt64Parameter(7, entry.date ? entry.date : now);
                insertIntoEntries.bindInt32Parameter(8, 0);
                insertIntoEntries.execute();

                if (entry.date && entry.date < oldestEntryDate)
                    oldestEntryDate = entry.date;
            }

            // Do not update the title, so that it is always taken from the Live Bookmark.
            var update = this.dBConnection.
                              createStatement('UPDATE feeds SET               ' +
                                              'websiteURL  = ?1,              ' +
                                              'subtitle    = ?2,              ' +
                                              'imageURL    = ?3,              ' +
                                              'imageLink   = ?4,              ' +
                                              'imageTitle  = ?5,              ' +
                                              'favicon     = ?6,              ' +
                                              'oldestAvailableEntryDate = ?7, ' +
                                              'everUpdated = 1                ' +
                                              'WHERE feedID = ?8              ');
            update.bindStringParameter(0, aFeed.websiteURL);
            update.bindStringParameter(1, aFeed.subtitle);
            update.bindStringParameter(2, aFeed.imageURL);
            update.bindStringParameter(3, aFeed.imageLink);
            update.bindStringParameter(4, aFeed.imageTitle);
            update.bindStringParameter(5, aFeed.favicon);
            update.bindInt64Parameter(6,  oldestEntryDate);
            update.bindStringParameter(7, aFeed.feedID);
            update.execute();
        }
        finally {
          this.dBConnection.commitTransaction();
        }

        var newUnreadCount = this.getEntriesCount(unreadEntriesQuery);
        var newEntriesCount = newUnreadCount - prevUnreadCount;
        var subject = Cc["@mozilla.org/variant;1"].createInstance(Ci.nsIWritableVariant);
        subject.setAsInt32(newEntriesCount);
        this.observerService.notifyObservers(subject, 'brief:feed-updated', aFeed.feedID);
    },


    // nsIBriefStorage
    markEntriesRead: function BriefStorage_markEntriesRead(aStatus, aQuery) {
        // Make sure not to select entries which already have the desired status.
        prevUnreadFlag = aQuery.unread;
        prevReadFlag = aQuery.read;
        if (aStatus)
            aQuery.unread = true;
        else
            aQuery.read = true;

        var statement = 'UPDATE entries SET read = ? ' + aQuery.getQueryText();

        var update = this.dBConnection.createStatement(statement)
        update.bindInt32Parameter(0, aStatus ? 1 : 0);

        this.dBConnection.beginTransaction();
        try {
            // Get the list of entries which are about to change, so the notification
            // can include it.
            var changedEntries = this.getSerializedEntries(aQuery);
            update.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
            aQuery.unread = prevUnreadFlag;
            aQuery.read = prevReadFlag;
        }

        // If any entries were marked, dispatch the notifiaction.
        if (changedEntries.getPropertyAsAString('entries')) {
            this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                                 aStatus ? 'read' : 'unread');
        }
    },


    // nsIBriefStorage
    deleteEntries: function BriefStorage_deleteEntries(aState, aQuery) {

        var statementString;
        switch (aState) {
            case Ci.nsIBriefStorage.ENTRY_STATE_NORMAL:
            case Ci.nsIBriefStorage.ENTRY_STATE_TRASHED:
            case Ci.nsIBriefStorage.ENTRY_STATE_DELETED:
                statementString = 'UPDATE entries SET deleted = ' + aState +
                                   aQuery.getQueryText();
                break;
            case Ci.nsIBriefStorage.REMOVE_FROM_DATABASE:
                statementString = 'DELETE FROM entries ' + aQuery.getQueryText();
                break;
            default:
                throw('Invalid deleted state.');
        }

        var statement = this.dBConnection.createStatement(statementString)
        this.dBConnection.beginTransaction();
        try {
            var changedEntries = this.getSerializedEntries(aQuery);
            statement.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                             'deleted');
    },


    // nsIBriefStorage
    starEntries: function BriefStorage_starEntries(aStatus, aQuery) {
        var statement = 'UPDATE entries SET starred = ? ' + aQuery.getQueryText();
        var update = this.dBConnection.createStatement(statement);
        update.bindInt32Parameter(0, aStatus ? 1 : 0);

        this.dBConnection.beginTransaction();
        try {
            var changedEntries = this.getSerializedEntries(aQuery);
            update.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                             'starred');
    },


    // Deletes entries that are outdated or exceed the max number per feed based.
    deleteRedundantEntries: function BriefStorage_deleteRedundantEntries() {
        var expireEntries = this.prefs.getBoolPref('database.expireEntries');
        var useStoreLimit = this.prefs.getBoolPref('database.limitStoredEntries');
        var expirationAge = this.prefs.getIntPref('database.entryExpirationAge');
        var maxEntries = this.prefs.getIntPref('database.maxStoredEntries');

        var edgeDate = Date.now() - expirationAge * 86400000; // expirationAge is in days
        var feeds = this.getAllFeeds({});

        var deleteOutdated = this.dBConnection.
            createStatement('UPDATE entries SET deleted=2 WHERE starred = 0 AND date < ?');

        var getEntriesCountForFeed = this.dBConnection.
            createStatement('SELECT COUNT(1) FROM entries     ' +
                            'WHERE starred = 0 AND feedID = ? ');

        var deleteExcessive = this.dBConnection.
            createStatement('UPDATE entries SET deleted = 2                 ' +
                            'WHERE id IN (SELECT id FROM entries            ' +
                            '             WHERE starred = 0 AND feedID = ?  ' +
                            '             ORDER BY date ASC LIMIT ?)        ');

        this.dBConnection.beginTransaction();
        try {
            if (expireEntries) {
                deleteOutdated.bindInt64Parameter(0, edgeDate);
                deleteOutdated.execute();
            }

            if (useStoreLimit) {
                var feedID, entryCount, difference;
                for (var i = 0; i < feeds.length; i++) {
                    feedID = feeds[i].feedID;

                    getEntriesCountForFeed.bindStringParameter(0, feedID);
                    getEntriesCountForFeed.executeStep()
                    entryCount = getEntriesCountForFeed.getInt32(0);
                    getEntriesCountForFeed.reset();

                    difference = entryCount - maxEntries;
                    if (difference > 0) {
                        deleteExcessive.bindStringParameter(0, feedID);
                        deleteExcessive.bindInt64Parameter(1, difference);
                        deleteExcessive.execute();
                    }
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
            'DELETE FROM entries WHERE id IN                                           ' +
            '(                                                                         ' +
            '   SELECT entries.id FROM entries INNER JOIN feeds                        ' +
            '   ON entries.feedID = feeds.feedID  WHERE                                ' +
            '   (entries.deleted = 2 AND feeds.oldestAvailableEntryDate > entries.date)' +
            '   OR                                                                     ' +
            '   (? - feeds.hidden > ? AND feeds.hidden != 0)                           ' +
            ')                                                                         ');
        removeEntries.bindInt64Parameter(0, Date.now());
        removeEntries.bindInt64Parameter(1, DELETED_FEEDS_RETENTION_TIME);
        removeEntries.execute();

        var removeFeeds = this.dBConnection.createStatement(
            'DELETE FROM feeds WHERE (? - feeds.hidden > ? AND feeds.hidden != 0)');
        removeFeeds.bindInt64Parameter(0, Date.now());
        removeFeeds.bindInt64Parameter(1, DELETED_FEEDS_RETENTION_TIME);
        removeFeeds.execute();

        this.stopDummyStatement();
        this.dBConnection.executeSimpleSQL('VACUUM');

        // Prefs can only store longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        this.prefs.setIntPref('database.lastPurgeTime', now);
    },


    // nsIObserver
    observe: function BriefStorage_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

            case 'quit-application':
                var lastTime = this.prefs.getIntPref('database.lastDeletedRedundantTime');
                var expireEntries = this.prefs.getBoolPref('database.expireEntries');
                var useStoreLimit = this.prefs.getBoolPref('database.limitStoredEntries');

                // Integer prefs are longs while Date is a long long.
                var now = Math.round(Date.now() / 1000);
                if (now - lastTime > DELETE_REDUNDANT_INTERVAL &&
                   (expireEntries || useStoreLimit)) {
                    this.deleteRedundantEntries();
                }

                lastTime = this.prefs.getIntPref('database.lastPurgeTime');
                if (now - lastTime > PURGE_DELETED_INTERVAL)
                    this.purgeDeletedEntries();

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
        if (!this.livemarksInitiated)
            this.initLivemarks();

        this.bookmarkItems = [];

        // Get the current Live Bookmarks
        this.rootURI = this.prefs.getCharPref('liveBookmarksFolder');
        if (!this.rootURI)
            throw('No Live Bookmarks folder specified (extensions.brief.liveBookmarksFolder is empty)');

        root = this.rdfs.GetResource(this.rootURI);
        this.traverseLivemarks(root);

        var feedListChanged = false;
        this.dBConnection.beginTransaction();
        try {
            // Insert any new livemarks into the feeds database
            var selectAll = this.dBConnection.
                createStatement('SELECT feedID, title, rowIndex, isFolder, parent, ' +
                                'RDF_URI, hidden FROM feeds                        ');

            var insertItem = this.dBConnection.
                createStatement('INSERT OR IGNORE INTO feeds                          ' +
                                '(feedID, feedURL, title, rowIndex, isFolder, parent, ' +
                                'RDF_URI) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)         ');
            var updateFeed = this.dBConnection.
                createStatement('UPDATE feeds SET                                  ' +
                                'title = ?, rowIndex = ?, parent = ?, RDF_URI = ?, ' +
                                'hidden = 0  WHERE feedID = ?                      ');
            var removeFeed = this.dBConnection.
                createStatement('DELETE FROM feeds WHERE feedID = ?');
            var hideFeed = this.dBConnection.
                createStatement('UPDATE feeds SET hidden = ? WHERE feedID =?');

            // Get all feeds currently in the database.
            var feeds = [];
            while (selectAll.executeStep()) {
                var feed = {};
                feed.feedID= selectAll.getString(0);
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
                    feedListChanged = true;
                }
                else {
                    // Mark that the feed is still in bookmarks.
                    feed.isInBookmarks = true;

                    // If the bookmark was found in the database then check if its row is
                    // up-to-date.
                    if (item.rowIndex != feed.rowIndex || item.parent != feed.parent ||
                       item.title != feed.title || item.uri != feed.rdf_uri || feed.hidden > 0) {
                        // Invalidate cache since feeds table is about to change
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
                            // has to be rebuilt, so we need to notify about it.
                            invalidateFeedList = true;
                        }
                        else {
                            // If only the title has changed, the feed list can be updated
                            // incrementally, so we send a different notification.
                            this.observerService.
                            notifyObservers(null,'brief:feed-title-changed', item.feedID);
                        }
                    }
                }
            }

            // Finally, remove any feeds that are no longer bookmarked.
            for (i = 0; i < feeds.length; i++) {
                feed = feeds[i];
                if (!feed.isInBookmarks) {
                    // Invalidate cache since feeds table is about to change
                    this.feedsCache = this.feedsAndFoldersCache = null;
                    invalidateFeedList = true;

                    if (feed.isFolder) {
                        removeFeed.bindStringParameter(0, feed.feedID);
                        removeFeed.execute();
                    }
                    else {
                        hideFeed.bindInt64Parameter(0, Date.now());
                        hideFeed.bindStringParameter(1, feed.feedID);
                        hideFeed.execute();
                    }
                }
            }
        }
        finally {
            this.dBConnection.commitTransaction();
            if (invalidateFeedList)
                this.observerService.notifyObservers(null, 'brief:invalidate-feedlist', '');
        }
    },


    // Separate function to initialize RDF resources to avoid doing it on every
    // traverseLivemarks() call.
    initLivemarks: function BriefStorage_initLivemarks() {
        this.rdfs = Cc['@mozilla.org/rdf/rdf-service;1'].getService(Ci.nsIRDFService);
        this.bmds = this.rdfs.GetDataSource('rdf:bookmarks');

        // Predicates
        this.nextValArc = this.rdfs.GetResource(RDF_NEXT_VAL);
        this.instanceOfArc = this.rdfs.GetResource(RDF_INSTANCE_OF);
        this.typeArc = this.rdfs.GetResource(RDF_TYPE);
        this.nameArc = this.rdfs.GetResource(NC_NAME);
        this.feedUrlArc = this.rdfs.GetResource(NC_FEEDURL);

        // Common resources
        this.sequence = this.rdfs.GetResource(RDF_SEQ_INSTANCE);
        this.livemarkType = this.rdfs.GetResource(NC_LIVEMARK);

        this.livemarksInitiated = true;
    },


    /**
     * Recursively reads livemarks from a folder and its subfolders
     * and stores them as an array in |livemark| member property.
     *
     * @param aFolder RDF URI of the folder containing the livemarks.
     */
     traverseLivemarks: function BriefStorage_traverseLivemarks(aFolder) {
        var nextVal = this.bmds.GetTarget(aFolder, this.nextValArc, true);
        var length = nextVal.QueryInterface(Ci.nsIRDFLiteral).Value - 1;
        for (var i = 1; i <= length; i++) {
            var seqArc = this.rdfs.GetResource(RDF_SEQ + i);
            var child = this.bmds.GetTarget(aFolder, seqArc, true);

            // Workaround a situation when nextVal value is incorrect after
            // sorting or removing bookmarks and can point to non-existent items.
            if (!child)
                continue;

            var type = this.bmds.GetTarget(child, this.typeArc, true);
            var instance = this.bmds.GetTarget(child, this.instanceOfArc, true);

            if (type == this.livemarkType) {
                var item = {};
                item.feedURL = this.bmds.GetTarget(child, this.feedUrlArc, true).
                                         QueryInterface(Ci.nsIRDFLiteral).
                                         Value;
                item.feedID = this.hashString(item.feedURL);
                item.uri = child.QueryInterface(Ci.nsIRDFResource).Value;
                item.title = this.bmds.GetTarget(child, this.nameArc, true).
                                       QueryInterface(Ci.nsIRDFLiteral).
                                       Value;
                item.rowIndex = this.bookmarkItems.length;
                item.isFolder = false;
                var parentURI = aFolder.QueryInterface(Ci.nsIRDFResource).Value;
                item.parent = parentURI == this.rootURI ? 'root'
                                                        : this.hashString(parentURI);
                this.bookmarkItems.push(item);
            }
            else if (instance == this.sequence) {
                var item = {};
                item.title = this.bmds.GetTarget(child, this.nameArc, true).
                                       QueryInterface(Ci.nsIRDFLiteral).
                                       Value;
                var uri = child.QueryInterface(Ci.nsIRDFResource).Value;
                item.uri = uri;
                item.feedID = this.hashString(uri);
                item.rowIndex = this.bookmarkItems.length;
                item.isFolder = true;
                var parentURI = aFolder.QueryInterface(Ci.nsIRDFResource).Value;
                item.parent = parentURI == this.rootURI ? 'root'
                                                        : this.hashString(parentURI);
                this.bookmarkItems.push(item);

                this.traverseLivemarks(child);
            }
        }
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
        this.dBConnection.executeSimpleSQL('CREATE TABLE IF NOT EXISTS ' +
                                           'dummy_table (id INTEGER PRIMARY KEY)');

        // This table is guaranteed to have something in it and will keep the dummy
        // statement open. If the table is empty, it won't hold the statement open.
        this.dBConnection.executeSimpleSQL('INSERT OR IGNORE INTO dummy_table VALUES (1)');

        this.dummyStatement = this.dummyDBConnection.
                                   createStatement('SELECT id FROM dummy_table LIMIT 1');

        // We have to step the dummy statement so that it will hold a lock on the DB
        this.dummyStatement.executeStep();
    },


    stopDummyStatement: function BriefStorage_stopDummyStatement() {
        // Do nothing if the dummy statement isn't running
        if (!this.dummyStatement)
            return;

        this.dummyStatement.reset();
        this.dummyStatement = null;
    },


    hashString: function BriefStorage_hashString(aString) {

        // nsICryptoHash can read the data either from an array or a stream.
        // Creating a stream ought to be faster than converting a long string
        // into an array using JS.
        // XXX nsIStringInputStream doesn't work well with UTF-16 strings; it's lossy, so
        // it increases the risk of collision.
        // nsIScriptableUnicodeConverter.convertToInputStream should be used instead but
        // it would result in different hashes and therefore duplicate entries for users
        // of older versions. For now, I have decided that the risk of collision isn't
        // big enough and it's not worth changing the method.
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
           !aIID.equals(Components.interfaces.nsISupports)) {
            throw Components.results.NS_ERROR_NO_INTERFACE;
        }
        return this;
    }

}

function BriefQuery() { }

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

    setConditions: function BriefQuery_setConditions(aFeeds, aEntries, aUnread) {
        this.feeds = aFeeds;
        this.entries = aEntries;
        this.unread = aUnread;
    },


    getQueryText: function BriefQuery_getQueryText(aForSelect) {
        if (aForSelect) {
            var text = 'WHERE '
        }
        else {
            var text = 'WHERE entries.id IN (SELECT entries.id FROM ' +
                       'entries INNER JOIN feeds ON entries.feedID = feeds.feedID WHERE ';
        }

        if (this.folders) {
            this._effectiveFolders = this.folders;
            this._items = Components.classes['@ancestor/brief/storage;1'].
                                     getService(Components.interfaces.nsIBriefStorage).
                                     getFeedsAndFolders({});
            this._traverseChildren('root');
            text += 'feeds.parent LIKE "%" || "' + this._effectiveFolders + '" || "%" AND ';
        }
        if (this.feeds) {
            text += 'entries.feedID LIKE "%" || "' + this.feeds + '" || "%" AND ';
        }
        if (this.entries) {
            text += 'entries.id LIKE "%" || "' + this.entries + '" || "%" AND ';
        }
        if (this.searchString) {
            text += 'entries.title || entries.summary || entries.content ' +
                    'LIKE "%" || "' + this.searchString + '" || "%" AND ';
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

    _traverseChildren: function BriefQuery__traverseChildren(aFolder) {
        var isEffectiveFolder = this._effectiveFolders.match(aFolder) ? true : false;
        var item, i;
        for (i = 0; i < this._items.length; i++) {
            item = this._items[i];
            if (item.parent == aFolder && item.isFolder) {
                if (isEffectiveFolder)
                    this._effectiveFolders += ' ' + aFolder;
                this._traverseChildren(item.feedID);
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


function Factory(aClassObject) {
    this._classObject = aClassObject;
}

Factory.prototype = {

    createInstance: function(aOuter, aIID) {
        if (aOuter != null)
            throw Components.results.NS_ERROR_NO_AGGREGATION;

        return (new this._classObject()).QueryInterface(aIID);
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
    },

    unregisterSelf: function(aCompMgr, aLocation, aType) {
        aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
        aCompMgr.unregisterFactoryLocation(CLASS_ID, aLocation);
    },

    getClassObject: function(aCompMgr, aCID, aIID) {
        if (!aIID.equals(Components.interfaces.nsIFactory))
            throw Components.results.NS_ERROR_NOT_IMPLEMENTED;

        if (aCID.equals(STORAGE_CLASS_ID))
            return new Factory(BriefStorageService);
        if (aCID.equals(QUERY_CLASS_ID))
            return new Factory(BriefQuery);

        throw Components.results.NS_ERROR_NO_INTERFACE;
    },

    canUnload: function(aCompMgr) { return true; }

}

// module initialization
function NSGetModule(aCompMgr, aFileSpec) { return Module; }
