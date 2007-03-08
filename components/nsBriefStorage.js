const CLASS_ID = Components.ID("{4C468DA8-7F30-11DB-A690-EBF455D89593}");
const CLASS_NAME = "Provides storage for feeds";
const CONTRACT_ID = "@mozilla.org/brief/storage;1";

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

// How often to delete entries that are have expired or exceed the max number of entries
// per feed.
const DELETE_REDUNDANT_INTERVAL = 3600000*24; // 1 day
// How often to permanently remove deleted entries and VACUUM the database.
const PURGE_DELETED_INTERVAL = 3600000*24*3; // 3 days

function logDBError(aException) {
    var error = gBriefStorage.dBConnection.lastErrorString;

    var consoleService = Cc['@mozilla.org/consoleservice;1'].
                         getService(Ci.nsIConsoleService);
    consoleService.logStringMessage('Brief - database error:\n ' + error + '\n\n '
                                    + aException);
}

var gBriefStorage = null;

function BriefStorage() {
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

    if (!this.dBConnection.tableExists('feeds') ||
        !this.dBConnection.tableExists('entries')) {
        this.dBConnection.
             executeSimpleSQL('CREATE TABLE IF NOT EXISTS feeds ( ' +
                              'feedId      TEXT UNIQUE,           ' +
                              'feedURL     TEXT,                  ' +
                              'websiteURL  TEXT,                  ' +
                              'title       TEXT,                  ' +
                              'subtitle    TEXT,                  ' +
                              'imageURL    TEXT,                  ' +
                              'imageLink   TEXT,                  ' +
                              'imageTitle  TEXT,                  ' +
                              'favicon     TEXT,                  ' +
                              'hidden      INTEGER DEFAULT 0,     ' +
                              'everUpdated INTEGER DEFAULT 0      ' +
                              ')');
        this.dBConnection.
             executeSimpleSQL('CREATE TABLE IF NOT EXISTS entries (' +
                              'feedId   TEXT,                      ' +
                              'id       TEXT UNIQUE,               ' +
                              'entryURL TEXT,                      ' +
                              'title    TEXT,                      ' +
                              'summary  TEXT,                      ' +
                              'content  TEXT,                      ' +
                              'date     INTEGER,                   ' +
                              'read     INTEGER DEFAULT 0,         ' +
                              'starred  INTEGER DEFAULT 0,         ' +
                              'deleted  INTEGER DEFAULT 0          ' +
                              ')');
    }
    try {
        this.dBConnection.
        executeSimpleSQL('ALTER TABLE feeds ADD COLUMN oldestAvailableEntryDate INTEGER');
    } catch (e) {}

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

BriefStorage.prototype = {

    observerService: null,
    briefPrefs:      null,
    dBConnection:    null,
    feedsCache:      null, //without entries

    // nsIBriefStorage
    getFeed: function(aFeedId) {
        var foundFeed = null;
        for each (feed in this.getAllFeeds({})) {
            if (feed.feedId == aFeedId)
                foundFeed = feed;
        }
        return foundFeed;
    },


    // nsIBriefStorage
    getAllFeeds: function(feedCount) {
        if (!this.feedsCache) {
            this.feedsCache = new Array();
            var select = this.dBConnection.
                createStatement('SELECT                                         ' +
                                'feedId, feedURL, websiteURL, title,            ' +
                                'subtitle, imageURL, imageLink, imageTitle,     ' +
                                'favicon, everUpdated, oldestAvailableEntryDate ' +
                                'FROM feeds                                     ' +
                                'WHERE hidden=0                                 ');
            try {
                while (select.executeStep()) {
                    var feed = Cc['@mozilla.org/brief/feed;1'].
                               createInstance(Ci.nsIBriefFeed);
                    feed.feedId = select.getString(0);
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
                    this.feedsCache.push(feed);
                }
            }
            finally {
                select.reset();
            }
        }
        // Set the |value| property of the out parameter object. XPConnect needs
        // this in order to return a array.
        feedCount.value = this.feedsCache.length;
        return this.feedsCache;
    },


    // nsIBriefStorage
    getEntries: function(aEntryId, aFeedId, aRules, aSearchString, aOffset,
                         aLimit, entryCount) {
        var statement = 'SELECT                                            ' +
                        'entries.id,    entries.feedId,  entries.entryURL, ' +
                        'entries.title, entries.summary, entries.content,  ' +
                        'entries.date,  entries.read,    entries.starred   ' +
                        'FROM entries INNER JOIN feeds                     ' +
                        'ON entries.feedId = feeds.feedId                  ' +
                        'WHERE                                             ' +
                        'feeds.hidden = 0 AND                              ' ;
        statement += this.createCommonConditions(aEntryId, aFeedId, aRules, aSearchString);
        statement = statement.replace(/AND\s*$/, ''); // Trim any trailing ANDs.
        statement += ' ORDER BY date DESC ';

        if (aLimit)
            statement += ' LIMIT ' + aLimit;
        if (aOffset)
            statement += ' OFFSET ' + aOffset;

        var select = this.dBConnection.createStatement(statement);
        var entries = new Array();
        try {
            while (select.executeStep()) {
                var entry = Cc['@mozilla.org/brief/feedentry;1'].
                            createInstance(Ci.nsIBriefFeedEntry);
                entry.id = select.getString(0);
                entry.feedId = select.getString(1);
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
    getSerializedEntries: function(aEntryId, aFeedId, aRules, aSearchString) {
        var statement = 'SELECT                            ' +
                        'entries.id, entries.feedId       ' +
                        'FROM entries INNER JOIN feeds     ' +
                        'ON entries.feedId = feeds.feedId  ' +
                        'WHERE                             ' +
                        'feeds.hidden = 0 AND              ' ;
        statement += this.createCommonConditions(aEntryId, aFeedId, aRules, aSearchString);
        statement = statement.replace(/AND\s*$/, ''); // Trim any trailing ANDs.

        var select = this.dBConnection.createStatement(statement);
        var entryIdList = '';
        var feedIdList = '';
        try {
            while (select.executeStep()) {
                var id = select.getString(0);
                if (!entryIdList.match(id))
                    entryIdList += id + ' ';

                var feedId = select.getString(1);
                if (!feedIdList.match(feedId))
                    feedIdList += feedId + ' ';
            }
        }
        finally {
            select.reset();
        }

        var bag = Cc['@mozilla.org/hash-property-bag;1'].
                  createInstance(Ci.nsIWritablePropertyBag2);
        bag.setPropertyAsAUTF8String('entryIdList', entryIdList);
        bag.setPropertyAsAUTF8String('feedIdList', feedIdList);

        return bag;
    },


    // nsIBriefStorage
    getEntriesCount: function(aFeedId, aRules, aSearchString) {
        var statement = 'SELECT COUNT(1)                   ' +
                        'FROM entries INNER JOIN feeds     ' +
                        'ON entries.feedId = feeds.feedId  ' +
                        'WHERE                             ' +
                        'feeds.hidden = 0 AND              ' ;
        statement += this.createCommonConditions(null, aFeedId, aRules, aSearchString);
        statement = statement.replace(/AND\s*$/, ''); // Trim any trailing ANDs.

        var select = this.dBConnection.createStatement(statement);

        var count = 0;
        try {
            while (select.executeStep())
                var count = select.getInt32(0);
        }
        finally {
            select.reset();
        }
        return count;
    },


    /**
     * This function creates the part of a statement that is most commonly shared by when
     * performing various actions, that is the conditions following the WHERE clause.
     */
     createCommonConditions: function(aEntryId, aFeedId, aRules, aSearchString) {
        var conditions = '';

        if (aEntryId)
            conditions += ' "' + aEntryId + '" LIKE "%" || entries.id || "%" ';
        if (aFeedId)
            conditions += ' AND "' + aFeedId + '" LIKE "%" || entries.feedId || "%" ';

        // If ids were specified, get the entries regardless of their deleted status.
        // Otherwise get only untrashed entries by default.
        if (!aEntryId)
          conditions += ' AND entries.deleted = 0 ';

        if (aRules) {
            if (aRules.match('unread'))
                conditions += ' AND entries.read = 0 ';
            if (aRules.match(/ read|^read/))
                conditions += ' AND entries.read = 1 ';

            if (aRules.match('unstarred'))
                conditions += ' AND entries.starred = 0 ';
            if (aRules.match(/ starred|^starred/))
                conditions += ' AND entries.starred = 1 ';

            if (aRules.match('trashed'))
                conditions = conditions.replace('deleted = 0', 'deleted = 1');
        }

        if (aSearchString)
            conditions += ' AND entries.title || entries.summary || entries.content' +
                         ' LIKE "%" || "' + aSearchString + '" || "%" ';

        // When appending conditions we don't know if any others were already appended
        // so we prepend every condition with AND. If there turns redundant AND at the
        // beginning we trim it here.
        var conditions = conditions.replace(/^ AND/, '');

        return conditions;
    },


    // nsIBriefStorage
    updateFeed: function(aFeed) {
        // Invalidate cache since feeds table is about to change.
        this.feedsCache = null;

        var oldestEntryDate = Date.now();

        var insertIntoEntries = this.dBConnection.
            createStatement('INSERT OR IGNORE INTO entries (        ' +
                            'feedId,                                ' +
                            'id,                                    ' +
                            'entryURL,                              ' +
                            'title,                                 ' +
                            'summary,                               ' +
                            'content,                               ' +
                            'date,                                  ' +
                            'read)                                  ' +
                            'VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ');
        this.dBConnection.beginTransaction();
        var prevUnreadCount = this.getEntriesCount(aFeed.feedId, 'unread');
        try {
            for each (entry in aFeed.getEntries({})) {
                var id = this.hashString(entry.entryURL + entry.title + entry.date);
                var title = entry.title.replace(/<[^>]+>/g,''); // Strip tags

                insertIntoEntries.bindStringParameter(0, aFeed.feedId);
                insertIntoEntries.bindStringParameter(1, id);
                insertIntoEntries.bindStringParameter(2, entry.entryURL);
                insertIntoEntries.bindStringParameter(3, title);
                insertIntoEntries.bindStringParameter(4, entry.summary);
                insertIntoEntries.bindStringParameter(5, entry.content);
                insertIntoEntries.bindInt64Parameter(6, entry.date ? entry.date
                                                                   : Date.now());
                insertIntoEntries.bindInt32Parameter(7, 0);
                insertIntoEntries.execute();

                if (entry.date && entry.date < oldestEntryDate)
                    oldestEntryDate = entry.date;
            }

            // Do not update title, so that it is always taken from the Live Bookmark.
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
                                              'WHERE feedId = ?8              ');
            update.bindStringParameter(0, aFeed.websiteURL);
            update.bindStringParameter(1, aFeed.subtitle);
            update.bindStringParameter(2, aFeed.imageURL);
            update.bindStringParameter(3, aFeed.imageLink);
            update.bindStringParameter(4, aFeed.imageTitle);
            update.bindStringParameter(5, aFeed.favicon);
            update.bindInt64Parameter(6,  oldestEntryDate);
            update.bindStringParameter(7, aFeed.feedId);
            update.execute();
        }
        finally {
          this.dBConnection.commitTransaction();
        }

        var newUnreadCount = this.getEntriesCount(aFeed.feedId, 'unread');
        var newEntriesCount = newUnreadCount - prevUnreadCount;
        var subject = Cc["@mozilla.org/variant;1"].createInstance(Ci.nsIWritableVariant);
        subject.setAsInt32(newEntriesCount);
        this.observerService.notifyObservers(subject, 'brief:feed-updated', aFeed.feedId);
    },


    // nsIBriefStorage
    markEntriesRead: function(aNewStatus, aEntryId, aFeedId, aRules, aSearchString) {
        var statement = 'UPDATE entries SET read = ? WHERE ';
        statement += this.createCommonConditions(aEntryId, aFeedId, aRules, aSearchString);

        var update = this.dBConnection.createStatement(statement)
        update.bindInt32Parameter(0, aNewStatus ? 1 : 0);

        this.dBConnection.beginTransaction();
        try {
            // Get the list of entries which are about to change, so the notification
            // can provide it.
            var rule = aNewStatus ? 'unread' : 'read';
            var changedEntries = this.getSerializedEntries(aEntryId, aFeedId,
                                                           aRules + ' ' + rule,
                                                           aSearchString);
            update.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                             aNewStatus ? 'read' : 'unread');
    },


    // nsIBriefStorage
    deleteEntries: function(aAction, aEntryId, aFeedId, aRules, aSearchString) {

        switch (aAction) {
            case 0:
            case 1:
            case 2:
                var statementString = 'UPDATE entries SET deleted = ' + aAction + ' WHERE ';
                break;
            case 3:
                var statementString = 'DELETE FROM entries WHERE ';
                break;
            default:
                throw('Invalid action specified when deleting entries.');
        }
        statementString += this.createCommonConditions(aEntryId, aFeedId, aRules,
                                                       aSearchString);

        var statement = this.dBConnection.createStatement(statementString)
        this.dBConnection.beginTransaction();
        try {
            var changedEntries = this.getSerializedEntries(aEntryId, aFeedId, aRules,
                                                           aSearchString);
            statement.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        this.observerService.notifyObservers(changedEntries, 'brief:entry-status-changed',
                                             'deleted');
    },


    // nsIBriefStorage
    starEntry: function(aEntryId, aNewStatus) {
        var update = this.dBConnection.
                          createStatement('UPDATE entries SET starred = ? WHERE id = ?');
        update.bindInt32Parameter(0, aNewStatus ? 1 : 0);
        update.bindStringParameter(1, aEntryId);

        this.dBConnection.beginTransaction();
        try {
            var changedEntries = this.getSerializedEntries(aEntryId);
            update.execute();
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        this.observerService.notifyObservers(changedEntries,
                                             'brief:entry-status-changed',
                                             'starred');
    },


    //  Deletes entries that are outdated or exceed the max number per feed based.
    deleteRedundantEntries: function() {
        var expireEntries = this.prefs.getBoolPref('database.expireEntries');
        var useStoreLimit = this.prefs.getBoolPref('database.limitStoredEntries');
        var expirationAge = this.prefs.getIntPref('database.entryExpirationAge');
        var maxEntries = this.prefs.getIntPref('database.maxStoredEntries');

        var edgeDate = Date.now() - expirationAge * 3600000;
        var feeds = this.getAllFeeds({});

        var deleteOutdated = this.dBConnection.
            createStatement('UPDATE entries SET deleted=2 WHERE starred = 0 AND date < ?');

        var getEntriesCountForFeed = this.dBConnection.
            createStatement('SELECT COUNT(1) FROM entries     ' +
                            'WHERE starred = 0 AND feedId = ? ');

        var deleteExcessive = this.dBConnection.
            createStatement('UPDATE entries SET deleted = 2                 ' +
                            'WHERE id IN (SELECT id FROM entries            ' +
                            '             WHERE starred = 0 AND feedId = ?  ' +
                            '             ORDER BY date ASC LIMIT ?)        ');

        this.dBConnection.beginTransaction();
        try {
            if (expireEntries) {
                deleteOutdated.bindInt64Parameter(0, edgeDate);
                deleteOutdated.execute();
            }

            if (useStoreLimit) {
                var feedId, entryCount, difference;
                for (var i = 0; i < feeds.length; i++) {
                    feedId = feeds[i].feedId;

                    getEntriesCountForFeed.bindStringParameter(0, feedId);
                    getEntriesCountForFeed.executeStep()
                    entryCount = getEntriesCountForFeed.getInt32(0);
                    getEntriesCountForFeed.reset();

                    difference = entryCount - maxEntries;
                    if (difference > 0) {
                        deleteExcessive.bindStringParameter(0, feedId);
                        deleteExcessive.bindInt64Parameter(1, difference);
                        deleteExcessive.execute();
                    }
                }
            }
        }
        finally {
            this.dBConnection.commitTransaction();
        }
        this.prefs.setIntPref('database.lastDeletedRedundantTime', Date.now());
    },


    // Permanently remove the deleted entries from database and VACUUM it. Should only
    // be run on shutdown.
    purgeDeletedEntries: function() {
        var remove = this.dBConnection.
            createStatement('DELETE FROM entries                                 ' +
                            'WHERE id IN                                         ' +
                            '  (SELECT entries.id FROM entries INNER JOIN feeds  ' +
                            '   ON entries.feedId = feeds.feedId  WHERE          ' +
                            '   entries.deleted = 2 AND                          ' +
                            '   feeds.oldestAvailableEntryDate > entries.date)   ');
        remove.execute();
        this.stopDummyStatement();
        this.dBConnection.executeSimpleSQL('VACUUM');
        this.prefs.setIntPref('database.lastPurgeTime', Date.now());
    },


    // nsIObserver
    observe: function(aSubject, aTopic, aData) {
        switch (aTopic) {

            case 'quit-application':
                var lastTime = this.prefs.getIntPref('database.lastDeletedRedundantTime');
                var expireEntries = this.prefs.getBoolPref('database.expireEntries');
                var useStoreLimit = this.prefs.getBoolPref('database.limitStoredEntries');
                if (Date.now() - lastTime > DELETE_REDUNDANT_INTERVAL &&
                    (expireEntries || useStoreLimit)){
                    this.deleteRedundantEntries();
                }

                lastTime = this.prefs.getIntPref('database.lastPurgeTime');
                if (Date.now() - lastTime > PURGE_DELETED_INTERVAL)
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
    syncWithBookmarks: function() {
        if (!this.livemarksInitiated)
            this.initLivemarks();

        this.livemarks = new Array();

        // Get the current Live Bookmarks
        var rootID = this.prefs.getCharPref('liveBookmarksFolder');
        if (!rootID)
            return;
        var root = this.rdfs.GetResource(rootID);
        this.getLivemarks(root);

        // Invalidate cache since feeds table is about to change
        this.feedsCache = null;

        this.dBConnection.beginTransaction();
        try {
            // Insert any new livemarks into the feeds database
            var insert = this.dBConnection.
                              createStatement('INSERT OR IGNORE INTO feeds ' +
                                              '(feedId, feedURL, title)    ' +
                                              'VALUES (?1, ?2, ?3)         ');
            for each (livemark in this.livemarks) {
                insert.bindStringParameter(0, livemark.feedId);
                insert.bindStringParameter(1, livemark.feedURL);
                insert.bindStringParameter(2, livemark.title);
                insert.execute();
            }

            // Mark all feeds as hidden
            this.dBConnection.executeSimpleSQL('UPDATE feeds SET hidden=1');

            // Unhide only those feeds that match the current user's livemarks
            // and update their titles
            var update = this.dBConnection.
                createStatement('UPDATE feeds SET hidden=0, title=?1 WHERE feedId=?2');
            for each (livemark in this.livemarks) {
                update.bindStringParameter(0, livemark.title);
                update.bindStringParameter(1, livemark.feedId);
                update.execute();
            }
        }
        finally {
            this.dBConnection.commitTransaction();
        }

        this.observerService.notifyObservers(null, 'brief:sync-to-livemarks', '');
    },


    // Separate function to initialize RDF resources to avoid doing it on every
    // getLivemarks() call.
    initLivemarks: function() {
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
     * This function recursively reads livemarks from a folder and its subfolders
     * and stores them as an array in |livemark| member property.
     *
     * @param aRoot RDF URI of the folder containing the livemarks.
     */
     getLivemarks: function(aRoot) {
        var nextVal = this.bmds.GetTarget(aRoot, this.nextValArc, true);
        var length = nextVal.QueryInterface(Ci.nsIRDFLiteral).Value - 1;

        for (var i = 1; i <= length; i++) {
            var seqArc = this.rdfs.GetResource(RDF_SEQ + i);
            var child = this.bmds.GetTarget(aRoot, seqArc, true);

            // XXX Workaround a situation when nextVal value is incorrect after
            // sorting or removing bookmarks. Don't know why this happens.
            if (!child)
                continue;
            var type = this.bmds.GetTarget(child, this.typeArc, true);
            if (type == this.livemarkType) {
                var livemark = new Object();
                livemark.feedURL = this.bmds.GetTarget(child, this.feedUrlArc, true).
                                             QueryInterface(Ci.nsIRDFLiteral).
                                             Value;
                livemark.feedId = this.hashString(livemark.feedURL);
                livemark.title = this.bmds.GetTarget(child, this.nameArc, true).
                                           QueryInterface(Ci.nsIRDFLiteral).
                                           Value;
                livemark.uri = child.QueryInterface(Ci.nsIRDFResource).ValueUTF8;
                this.livemarks.push(livemark);
            }
            else {
                var instance = this.bmds.GetTarget(child, this.instanceOfArc, true);
                if (instance == this.sequence)
                    this.getLivemarks(child);
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
    startDummyStatement: function() {
        // Make sure the dummy table exists.
        if (!this.dBConnection.tableExists('dummy_table')) {
            this.dBConnection.
                 executeSimpleSQL('CREATE TABLE dummy_table (id INTEGER PRIMARY KEY)');
        }

        // This table is guaranteed to have something in it and will keep the dummy
        // statement open. If the table is empty, it won't hold the statement open.
        this.dBConnection.
             executeSimpleSQL('INSERT OR IGNORE INTO dummy_table VALUES (1)');

        this.dummyStatement = this.dummyDBConnection.
                                   createStatement('SELECT id FROM dummy_table LIMIT 1');

        // We have to step the dummy statement so that it will hold a lock on the DB
        this.dummyStatement.executeStep();
    },


    stopDummyStatement: function() {
        // Do nothing if the dummy statement isn't running
        if (!this.dummyStatement)
            return;

        this.dummyStatement.reset();
        this.dummyStatement = null;
    },


    hashString: function(aString) {
        var hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);

        // nsICryptoHash can read the data either from an array or a stream.
        // Creating a stream ought to be faster than converting a long string
        // into an array using JS.
        var stringStream = Cc["@mozilla.org/io/string-input-stream;1"].
                           createInstance(Ci.nsIStringInputStream);
        stringStream.setData(aString, aString.length);

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


    // nsISupports
    QueryInterface: function(aIID) {
        if (!aIID.equals(Components.interfaces.nsIBriefStorage) &&
            !aIID.equals(Components.interfaces.nsISupports) &&
            !aIID.equals(Components.interfaces.nsIObserver) &&
            !aIId.equals(Components.inerfaces.nsITimerCallback))
            throw Components.results.NS_ERROR_NO_INTERFACE;
        return this;
    }

}


var Factory = {
    createInstance: function(aOuter, aIID) {
        if (aOuter != null)
            throw Components.results.NS_ERROR_NO_AGGREGATION;
        if (!gBriefStorage)
            gBriefStorage = new BriefStorage();
        return gBriefStorage.QueryInterface(aIID);
    },

    getService: function(aIID) {
        if (!gBriefStorage)
            gBriefStorage = new BriefStorage();
        return gBriefStorage.QueryInterface(Components.interfaces.nsIBriefStorage);
    }
}

//module definition (xpcom registration)
var Module = {
    _firstTime: true,

    registerSelf: function(aCompMgr, aFileSpec, aLocation, aType) {
        aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
        aCompMgr.registerFactoryLocation(CLASS_ID, CLASS_NAME, CONTRACT_ID,
                                         aFileSpec, aLocation, aType);
    },

    unregisterSelf: function(aCompMgr, aLocation, aType) {
        aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
        aCompMgr.unregisterFactoryLocation(CLASS_ID, aLocation);
    },

    getClassObject: function(aCompMgr, aCID, aIID) {
        if (!aIID.equals(Components.interfaces.nsIFactory))
            throw Components.results.NS_ERROR_NOT_IMPLEMENTED;

        if (aCID.equals(CLASS_ID))
            return Factory;

        throw Components.results.NS_ERROR_NO_INTERFACE;
    },

    canUnload: function(aCompMgr) { return true; }

}

//module initialization
function NSGetModule(aCompMgr, aFileSpec) { return Module; }
