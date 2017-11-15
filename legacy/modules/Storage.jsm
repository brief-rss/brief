// Time in milliseconds
const PURGE_ENTRIES_INTERVAL = 3600*24*1000; // 1 day
const DELETED_FEEDS_RETENTION_TIME = 3600*24*7*1000; // 1 week
const LIVEMARKS_SYNC_DELAY = 100;
const BACKUP_FILE_EXPIRATION_AGE = 3600*24*14*1000; // 2 weeks
const DATABASE_VERSION = 18;
const DATABASE_CACHE_SIZE = 256; // With the default page size of 32KB, it gives us 8MB of cache memory.
const MAX_WAL_CHECKPOINT_SIZE = 16; // Checkpoint every 512KB for the default page size

// Reuse the same pref for transition period
const PREF_LAST_VACUUM = 'storage.vacuum.last.brief.sqlite';
const VACUUM_PERIOD = 3600*24*30*1000; // 1 month


const FEEDS_COLUMNS = FEEDS_TABLE_SCHEMA.map(col => col.name);
const ENTRIES_COLUMNS = ENTRIES_TABLE_SCHEMA.map(col => col.name).concat(
                        ENTRIES_TEXT_TABLE_SCHEMA.map(col => col.name));

let StorageInternal = {

    // See Storage.
    get ready() { return this.deferredReady.promise },

    deferredReady: PromiseUtils.defer(),

    feedCache: null,

    entryChanges: new DataStream(),


    init: function* StorageInternal_init() {
        try {
            Connection = yield Sqlite.openConnection({ path: 'brief.sqlite',
                                                       sharedMemoryCache: false });
        }
        catch (ex) {
            // The database was corrupted, back it up and create a new one.
            this.resetDatabase();
        }

        let schemaVersion = Number.parseInt((yield Connection.getSchemaVersion()), 10);

        if (schemaVersion == 0) {
            yield this.setupDatabase();
        }
        else if (schemaVersion < DATABASE_VERSION) {
            yield this.upgradeDatabase(schemaVersion);
        }

        yield Connection.execute('PRAGMA cache_size = ' + DATABASE_CACHE_SIZE);
        // limit the WAL size
        yield Connection.execute('PRAGMA wal_autocheckpoint = ' + MAX_WAL_CHECKPOINT_SIZE);
        yield Connection.execute('PRAGMA journal_size_limit = ' + (3*32768*MAX_WAL_CHECKPOINT_SIZE));

        // Build feed cache.
        let feedCache = [];
        yield Stm.getAllFeeds.execute(null, row => {
            let feed = {};
            for (let column of FEEDS_COLUMNS)
                feed[column] = row[column];

            feedCache.push(feed);
        });

        this.feedCache = new DataSource(feedCache);

        this.homeFolderID = Prefs.getIntPref('homeFolder');
        this.ensureHomeFolder();

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

    setupDatabase: function* Database_setupDatabase() {
        Services.prefs.setIntPref(PREF_LAST_VACUUM, Math.round(Date.now() / 1000));
        makeCol = col => col['name'] + ' ' + col['type'] +
                         ('default' in col ? ' DEFAULT ' + col['default'] : '');
        schemaString = schema => schema.map(col => makeCol(col)).join();

        let sqlStrings = [
            'CREATE TABLE feeds (' + schemaString(FEEDS_TABLE_SCHEMA) + ') ',
            'CREATE TABLE entries (' + schemaString(ENTRIES_TABLE_SCHEMA) + ') ',
            'CREATE TABLE entry_tags (' + schemaString(ENTRY_TAGS_TABLE_SCHEMA) + ') ',
            'CREATE VIRTUAL TABLE entries_text USING fts4 (' + schemaString(ENTRIES_TEXT_TABLE_SCHEMA) + ')',

            'CREATE INDEX entries_date_index ON entries (date)',
            'CREATE INDEX entries_feedID_date_index ON entries (feedID, date)',
            'CREATE INDEX entries_primaryHash_index ON entries (primaryHash)',
            'CREATE INDEX entries_bookmarkID_index ON entries (bookmarkID)',
            'CREATE INDEX entries_entryURL_index ON entries (entryURL)',
            'CREATE INDEX entry_tagName_index ON entry_tags (tagName)',

            'PRAGMA journal_mode=WAL',
            'ANALYZE'
        ]

        for (let sql of sqlStrings)
            yield Connection.execute(sql);

        yield Connection.setSchemaVersion(DATABASE_VERSION);
    }.task(),

    //TODO: is all this needed for sqlite import?
    upgradeDatabase: function* StorageInternal_upgradeDatabase(aPrevVersion) {
        // No support for migration from versions older than 1.2.
        if (aPrevVersion < 9) {
            this.resetDatabase();
            return;
        }

        let dbPath = OS.Path.join(OS.Constants.Path.profileDir, 'brief.sqlite');
        let backupPath = OS.Path.join(OS.Constants.Path.profileDir, 'brief-backup.sqlite');
        yield OS.File.copy(dbPath, backupPath);

        let sqlStrings = [];

        switch (aPrevVersion) {
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
            yield Connection.execute(sql);

        yield Connection.setSchemaVersion(DATABASE_VERSION);
    }.task(),


    /**
     * Inserts one or more feeds into the database, updates cache,
     * and sends notifications.
     *
     * @param aFeeds <object> or <array <object>>
     *        An object or an array of objects containing the following properties:
     *        feedID, feedURL, title, rowIndex, isFolder, parent, bookmarkID.
     */
    addFeeds: function* StorageInternal_addFeeds(aItems) {
        let items = Array.isArray(aItems) ? aItems : [aItems];
        let paramSets = [];

        let feedCache = this.feedCache.get();
        for (let feedData of items) {
            paramSets.push({
                'feedID'    : feedData.feedID,
                'feedURL'   : feedData.feedURL || null,
                'title'     : feedData.title,
                'rowIndex'  : feedData.rowIndex,
                'isFolder'  : feedData.isFolder ? 1 : 0,
                'parent'    : feedData.parent,
                'bookmarkID': feedData.bookmarkID
            })

            // Update cache.
            let feed = {};
            for (let column of FEEDS_TABLE_SCHEMA)
                feed[column.name] = feedData[column.name] || column['default'];

            feedCache.push(feed);
        }

        this.feedCache.set(feedCache.sort((a, b) => a.rowIndex - b.rowIndex));

        Services.obs.notifyObservers(null, 'brief:invalidate-feedlist', '');

        yield Stm.insertFeed.executeCached(paramSets);

        let feeds = items.filter(item => !item.isFolder)
                         .map(item => this.getFeed(item.feedID));
        FeedUpdateService.updateFeeds(feeds);
    }.task(),

    /**
     * Moves entries to Trash if they exceed the age limit or the number limit.
     *
     * @param aFeed [optional]
     *        The feed whose entries to expire. If not provided, all feeds are processed.
     */
    expireEntries: function* StorageInternal_expireEntries(aFeed) {
        let feeds = aFeed ? [aFeed] : this.getAllFeeds();

        let feedsWithAgeLimit = feeds.filter(f => f.entryAgeLimit);
        let feedsWithoutAgeLimit = feeds.filter(f => !f.entryAgeLimit);

        // Delete entries exceeding the global number limit.
        if (Prefs.getBoolPref('database.limitStoredEntries')) {
            for (let feed of feeds) {
                let query = new Query({
                    feeds: [feed.feedID],
                    deleted: false,
                    starred: false,
                    sortOrder: 'date',
                    offset: Prefs.getIntPref('database.maxStoredEntries')
                })

                yield query.deleteEntries('trashed');
            }
        }

        // Delete old entries in feeds that don't have per-feed setting enabled.
        if (Prefs.getBoolPref('database.expireEntries') && feedsWithoutAgeLimit.length) {
            let expirationAge = Prefs.getIntPref('database.entryExpirationAge');

            let query = new Query({
                feeds: feedsWithoutAgeLimit.map(feed => feed.feedID),
                deleted: false,
                starred: false,
                endDate: Date.now() - expirationAge * 86400000
            })

            yield query.deleteEntries('trashed');
        }

        // Delete old entries based on per-feed limit.
        if (feedsWithAgeLimit.length) {
            for (let feed of feedsWithAgeLimit) {
                let query = new Query({
                    feeds: [feed.feedID],
                    deleted: false,
                    starred: false,
                    endDate: Date.now() - feed.entryAgeLimit * 86400000
                })

                query.deleteEntries('trashed');
            }
        }
    }.task(),

    // Permanently removes deleted items from database.
    purgeDeleted: async function StorageInternal_purgeDeleted() {
        let text = Stm.purgeDeletedEntriesText.execute({
            'deletedState': EntryState.DELETED,
            'currentDate': Date.now(),
            'retentionTime': DELETED_FEEDS_RETENTION_TIME
        }).then(result => {
            // Partially merge the FTS trees
            return Stm.entriesTextCompact.execute({options: 'merge=200,8'});
        });

        let entries = Stm.purgeDeletedEntries.execute({
            'deletedState': EntryState.DELETED,
            'currentDate': Date.now(),
            'retentionTime': DELETED_FEEDS_RETENTION_TIME
        });

        let feeds = Stm.purgeDeletedFeeds.execute({
            'currentDate': Date.now(),
            'retentionTime': DELETED_FEEDS_RETENTION_TIME
        });

        await Promise.all([text, entries, feeds]);
        this.entryChanges.push({action: 'purge'});
        // Prefs can only store longs while Date is a long long.
        let now = Math.round(Date.now() / 1000);
        Prefs.setIntPref('database.lastPurgeTime', now);
        let last_vacuum = Services.prefs.getIntPref(PREF_LAST_VACUUM);
        if((now - last_vacuum) * 1000 > VACUUM_PERIOD) {
            await wait(15000); // Avoid colliding with another vacuum, if possible
            FeedUpdateService.stopUpdating();
            await Stm.vacuum.execute();
            Services.prefs.setIntPref(PREF_LAST_VACUUM, Math.round(Date.now() / 1000));
        }
    },


                // Remove the backup file after certain amount of time. TODO

            case 'nsPref:changed':
                switch (aData) {
                    case 'database.expireEntries':
                    case 'database.limitStoredEntries':
                        if (Prefs.getBoolPref(aData))
                            this.expireEntries();//TODO
                        break;

                    case 'database.entryExpirationAge':
                    case 'database.maxStoredEntries':
                        this.expireEntries();
                        break;
                }
                break;
        }
    }.task(),


}


// See Storage.processFeed().
function FeedProcessor(aFeedID, aParsedFeed, aFeedDocument, aDeferred) {
    this.feed = Storage.getFeed(aFeedID);
    this.parsedFeed = aParsedFeed;
    this.deferred = aDeferred;

    let newDateModified = new Date(aParsedFeed.updated).getTime();
    let prevDateModified = this.feed.dateModified;

    let hasItems = aParsedFeed.items && aParsedFeed.items.length;
    if (hasItems && (!newDateModified || newDateModified > prevDateModified)) {
        this.remainingEntriesCount = aParsedFeed.items.length;
        this.newOldestEntryDate = Date.now();

        this.updatedEntries = [];

        this.updateEntryParamSets = [];
        this.insertEntryParamSets = [];
        this.updateEntryTextParamSets = [];
        this.insertEntryTextParamSets = [];

        // Counting down, because the order of items is reversed after parsing.
        // This is to ensure the original order of entries if they don't have dates.
        for (let i = aParsedFeed.items.length - 1; i >= 0; i--) {
            let parsedEntry = aParsedFeed.items.queryElementAt(i, Ci.nsIFeedEntry);
            let mappedEntry = this.mapEntryProperties(parsedEntry);
            this.processEntry(mappedEntry);
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

    mapEntryProperties: function FeedProcessor_mapEntryProperties(aEntry) {
        let updatedTimestamp = (aEntry.updated ?
            Utils.getRFC822Date(aEntry.updated).getTime() : Date.now());
        let mappedEntry = {
            title:    aEntry.title     ? aEntry.title.text   : '',
            entryURL: aEntry.link      ? aEntry.link.spec    : '',
            summary:  aEntry.summary   ? aEntry.summary.text : '',
            content:  aEntry.content   ? aEntry.content.text : '',
            date:     aEntry.published ? Utils.getRFC822Date(aEntry.published).getTime() : updatedTimestamp,
            updated:  updatedTimestamp
        }

        try {
            if (aEntry.authors) {
                let authors = [];
                for (let i = 0; i < aEntry.authors.length; i++) {
                    let author = aEntry.authors.queryElementAt(i, Ci.nsIFeedPerson).name;
                    authors.push(author);
                }
                mappedEntry.authors = authors.join(', ');
            }
        }
        catch (ex) {
            // Accessing nsIFeedContainer.authors sometimes fails.
        }

        mappedEntry.wrappedEntry = aEntry;

        return mappedEntry;
    },

    processEntry: function* FeedProcessor_processEntry(aEntry) {
        if (aEntry.date && aEntry.date < this.newOldestEntryDate)
            this.newOldestEntryDate = aEntry.date;

        // This function checks whether a downloaded entry is already in the database or
        // it is a new one. To do this we need a way to uniquely identify entries. Many
        // feeds don't provide unique identifiers for their entries, so we have to use
        // hashes for this purpose. See entries table schema for details.
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
        let select = providedID ? Stm.getEntryByPrimaryHash : Stm.getEntryBySecondaryHash;
        let params = { hash: providedID ? primaryHash : secondaryHash };
        let storedEntry = (yield select.executeCached(params))[0];

        if (storedEntry) {
            if (aEntry.updated && aEntry.updated > storedEntry.updated)
                this.addUpdateParams(aEntry, storedEntry.id, storedEntry.read);
        }
        else {
            this.addInsertParams(aEntry, primaryHash, secondaryHash);
        }

        if (!--this.remainingEntriesCount)
            this.executeAndNotify();
    }.task(),

    addUpdateParams: function FeedProcessor_addUpdateParams(aEntry, aStoredEntryID, aIsRead) {
        let title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags
        let markUnread = Storage.getFeed(this.feed.feedID).markModifiedEntriesUnread;

        this.updateEntryParamSets.push({
            'updated': aEntry.updated,
            'read': markUnread && aIsRead == 1 ? 2 : aIsRead,
            'id': aStoredEntryID
        })

        this.updateEntryTextParamSets.push({
            'title': title,
            'content': aEntry.content || aEntry.summary,
            'authors': aEntry.authors,
            'id': aStoredEntryID
        })

        this.updatedEntries.push(aStoredEntryID);
    },

    addInsertParams: function FeedProcessor_addInsertParams(aEntry, aPrimaryHash, aSecondaryHash) {
        let title = aEntry.title ? aEntry.title.replace(/<[^>]+>/g, '') : ''; // Strip tags

        this.insertEntryParamSets.push({
            'feedID': this.feed.feedID,
            'primaryHash': aPrimaryHash,
            'secondaryHash': aSecondaryHash,
            'providedID': aEntry.wrappedEntry.id,
            'entryURL': aEntry.entryURL,
            'date': aEntry.date || Date.now(),
            'updated': aEntry.updated || 0
        })

        this.insertEntryTextParamSets.push({
            'title': title,
            'content': aEntry.content || aEntry.summary,
            'authors': aEntry.authors
        })
    },

    executeAndNotify: function* FeedProcessor_executeAndNotify() {
        let insertedEntries = [];

        if (this.insertEntryParamSets.length) {
            yield Connection.executeTransaction(() => {
                Stm.insertEntry.executeCached(this.insertEntryParamSets);
                Stm.insertEntryText.executeCached(this.insertEntryTextParamSets);
                Stm.getLastRowids.executeCached(
                    { count: this.insertEntryParamSets.length },
                    row => insertedEntries.push(row.id)
                )
            })

            let entryList = yield new Query(insertedEntries).getEntryList();

            StorageInternal.notifyObservers('entriesAdded', {entryList});

            StorageInternal.expireEntries(this.feed);
        }

        if (this.updateEntryParamSets.length) {
            yield Connection.executeTransaction(() => {
                Stm.updateEntry.executeCached(this.updateEntryParamSets);
                Stm.updateEntryText.executeCached(this.updateEntryTextParamSets);
            })

            let entryList = yield new Query(this.updatedEntries).getEntryList();

            StorageInternal.notifyObservers('entriesUpdated', {entryList});
        }

        this.deferred.resolve(insertedEntries.length);
    }.task()

}



//TODO: see this for OPML import
/**
 * Synchronizes the list of feeds stored in the database with
 * the livemarks available in the Brief's home folder.
 */
let LivemarksSync = function* LivemarksSync() {
    yield this.traversePlacesQueryResults(result.root, livemarks);

    let storedFeeds = Storage.getAllFeeds(true, true);
    let storedFeedsByID = new Map(storedFeeds.map(feed => [feed.feedID, feed]));
    let processedFeedIds = new Set();
    let newFeeds = [];
    let changedFeeds = [];

    // Iterate through the found livemarks and compare them
    // with the feeds in the database.
    for (let livemark of livemarks) {
        if (processedFeedIds.has(livemark.feedID))
            continue;
        processedFeedIds.add(livemark.feedID);

        // Feed already in the database.
        let feed = storedFeedsByID.get(livemark.feedID);
        if (feed) {
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
    if (newFeeds.length)
        StorageInternal.addFeeds(newFeeds);

    if (changedFeeds.length)
        Storage.changeFeedProperties(changedFeeds);
}.task();

LivemarksSync.prototype = {

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
    traversePlacesQueryResults: function* BookmarksSync_traversePlacesQueryResults(aContainer, aLivemarks) {
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

            try {
                let placesItem = yield Places.livemarks.getLivemark({ 'id': node.itemId });

                item.feedURL = placesItem.feedURI.spec;
                item.feedID = Utils.hashString(item.feedURL);
                item.isFolder = false;

                aLivemarks.push(item);
            }
            // Since there's no livermarkExists() method, we have to differentiate
            // between livermarks and folders by catching an exception.
            catch (ex if "result" in ex && ex.result == Components.results.NS_ERROR_INVALID_ARG) {
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



// Predefined SQL statements.
let Stm = {

    get insertEntry() {
        let sql = 'INSERT INTO entries (feedID, primaryHash, secondaryHash, providedID, entryURL, date, updated) ' +
                  'VALUES (:feedID, :primaryHash, :secondaryHash, :providedID, :entryURL, :date, :updated)        ';
        return new Statement(sql);
    },

    get insertEntryText() {
        let sql = 'INSERT INTO entries_text (title, content, authors) ' +
                  'VALUES(:title, :content, :authors)   ';
        return new Statement(sql);
    },

    get updateEntry() {
        let sql = 'UPDATE entries SET read = :read, updated = :updated '+
                  'WHERE id = :id                                             ';
        return new Statement(sql);
    },

    get updateEntryText() {
        let sql = 'UPDATE entries_text SET title = :title, content = :content, '+
                  'authors = :authors WHERE rowid = :id                        ';
        return new Statement(sql);
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
        return new Statement(sql);
    },

    get purgeDeletedEntries() {
        let sql = 'DELETE FROM entries                                                      '+
                  'WHERE id IN (                                                            '+
                  '   SELECT entries.id                                                     '+
                  '   FROM entries INNER JOIN feeds ON entries.feedID = feeds.feedID        '+
                  '   WHERE (entries.deleted = :deletedState AND feeds.oldestEntryDate > entries.date) '+
                  '         OR (:currentDate - feeds.hidden > :retentionTime AND feeds.hidden != 0)    '+
                  ')                                                                                   ';
        return new Statement(sql);
    },

    get purgeDeletedFeeds() {
        let sql = 'DELETE FROM feeds                                      '+
                  'WHERE :currentDate - feeds.hidden > :retentionTime AND '+
                  '      feeds.hidden != 0                                ';
        return new Statement(sql);
    },

    get insertFeed() {
        let sql = 'INSERT OR IGNORE INTO feeds                                                   ' +
                  '(feedID, feedURL, title, rowIndex, isFolder, parent, bookmarkID)              ' +
                  'VALUES (:feedID, :feedURL, :title, :rowIndex, :isFolder, :parent, :bookmarkID)';
        return new Statement(sql);
    }

}


let Utils = {

    getFeedByBookmarkID: function getFeedByBookmarkID(aBookmarkID) {
        for (let feed of Storage.getAllFeeds(true)) {
            if (feed.bookmarkID == aBookmarkID)
                return feed;
        }

        return null;
    },

    getEntriesByURL: function* getEntriesByURL(aURL) {
        let results = yield Stm.selectEntriesByURL.executeCached({ url: aURL });
        return results.map(row => row.id);
    }.task(),

    getEntriesByBookmarkID: function* getEntriesByBookmarkID(aID) {
        let results = yield Stm.selectEntriesByBookmarkID.executeCached({ bookmarkID: aID });
        return results.map(row => row.id);
    }.task(),

    getRFC822Date: function(aDateString) {
        let date = new Date(aDateString);

        // If the date is invalid, it may be caused by the fact that the built-in date parser
        // doesn't handle military timezone codes, even though they are part of RFC822.
        // We can fix this by manually replacing the military timezone code with the actual
        // timezone.
        if (date.toString().match(/invalid/i)) {
            let timezoneCodes = aDateString.match(/\s[a-ik-zA-IK-Z]$/);
            if (timezoneCodes) {
                let timezoneCode = timezoneCodes[0];
                // Strip whitespace and normalize to upper case.
                timezoneCode = timezoneCode.replace(/^\s+/,'')[0].toUpperCase();
                let timezone = this.milTimezoneCodesMap[timezoneCode];
                let fixedDateString = aDateString.replace(/\s[a-ik-zA-IK-Z]$/, ' ' + timezone);
                date = new Date(fixedDateString);
            }

            // If the date is still invalid, just use the current date.
            if (date.toString().match(/invalid/i))
                date = new Date();
        }

        return date;
    },

    // Conversion table for military coded timezones.
    milTimezoneCodesMap: {
        A: '-1',  B: '-2',  C: '-3',  D: '-4', E: '-5',  F: '-6',  G: '-7',  H: '-8', I: '-9',
        K: '-10', L: '-11', M: '-12', N: '+1', O: '+2',  P: '+3',  Q: '+4',  R: '+5',
        S: '+6',  T: '+7',  U: '+8',  V: '+9', W: '+10', X: '+11', Y: '+12', Z: 'UT',
    }

}
