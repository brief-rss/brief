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

// Constructors for nsIBriefFeed and nsIBriefFeedEntry
var Feed = null;
var FeedEntry = null;

var gBriefStorage = null;

function logDBError(aException) {
  var error = gBriefStorage.dBConnection.lastErrorString;

  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief - database error:\n ' + error + '\n\n '
                                  + aException);
};


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

  this.startDummyStatement();
  this.dBConnection.preload();

  Feed = new Components.Constructor('@mozilla.org/brief/feed;1','nsIBriefFeed');
  FeedEntry = new Components.Constructor('@mozilla.org/brief/feedentry;1',
                                         'nsIBriefFeedEntry');
  this.observerService = Cc['@mozilla.org/observer-service;1'].
                         getService(Ci.nsIObserverService);
  this.briefPrefs = Cc["@mozilla.org/preferences-service;1"].
                    getService(Ci.nsIPrefService).
                    getBranch('extensions.brief.');
  this.briefPrefs.QueryInterface(Ci.nsIPrefBranch2).addObserver('', this, false);
};

BriefStorage.prototype = {

  observerService: null,
  briefPrefs:      null,
  dBConnection:    null,
  feedsCache:      null, //without entries

  // nsIBriefStorage
  getFeed: function(aFeedId) {
    var foundFeed = null;
    for each (feed in this.getAllFeeds({}))
      if (feed.feedId == aFeedId)
        foundFeed = feed;
    return foundFeed;
  },


  // nsIBriefStorage
  getAllFeeds: function(feedCount) {
    if (!this.feedsCache) {
      this.feedsCache = new Array();
      var select = this.dBConnection.
          createStatement('SELECT                                    ' +
                          'feedId, feedURL, websiteURL, title,       ' +
                          'subtitle, imageURL, imageLink, imageTitle,' +
                          'favicon, everUpdated,                     ' +
                          'UPPER(title) AS uctitle                   ' +
                          'FROM feeds                                ' +
                          'WHERE hidden=0 ORDER BY uctitle           ');
      try {
        while (select.executeStep()) {
          var feed = new Feed();
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

    var select = this.buildGetEntriesStatement('full', aEntryId, aFeedId, aRules,
                                               aSearchString, aOffset, aLimit);
    var entries = new Array();
    try {
      while (select.executeStep()) {
        var entry = new FeedEntry();
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
    var select = this.buildGetEntriesStatement('serialized', aEntryId, aFeedId,
                                               aRules, aSearchString);

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
    var select = this.buildGetEntriesStatement('count', null, aFeedId, aRules,
                                               aSearchString);

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
  * This is a function to avoid code duplication. It builds the statement for
  *
  * @param aMode  Type of statement to create. 'full' to generate statement for
  *               getEntries(), 'count' for getEntriesCount(), 'serialized' for
  *               getSerializedEntries()
  *
  * The rest of parameters as in the respective callers.
  */
  buildGetEntriesStatement: function(aMode, aEntryId, aFeedId, aRules,
                                     aSearchString, aOffset, aLimit) {
    // This is the template for our statement.
    var statement = 'SELECT _columnList_                  ' +
                    'FROM entries INNER JOIN feeds        ' +
                    'ON entries.feedId = feeds.feedId     ' +
                    'WHERE                                ' +
                    'feeds.hidden = 0                     ' +
                    '_entryIdCondition_                   ' +
                    '_feedIdCondition_                    ' +
                    '_readCondition_                      ' +
                    '_starredCondition_                   ' +
                    '_deletedCondition_                   ' +
                    '_searchFilter_                       ' +
                    '_orderByClause_                      ' +
                    '_limitClause_                        ' +
                    '_offsetClause_                       ' ;

    // Initialize the strings.
    var entryIdCondition = feedIdCondition = readCondition = starredCondition =
        deletedCondition = orderByClause = searchFilter = limitClause =
        offsetClause = '';

    if (aMode == 'serialized')
      var columnList = 'entries.id, entries.feedId';
    else if (aMode == 'count')
      var columnList = 'COUNT(1)';
    else if (aMode == 'full')
      columnList = 'entries.id,    entries.feedId,  entries.entryURL, ' +
                   'entries.title, entries.summary, entries.content,  ' +
                   'entries.date,  entries.read,    entries.starred   ';
    else
      throw('Mode must be defined to build a statement.');


    if (aEntryId)
      entryIdCondition = 'AND "' + aEntryId + '" LIKE "%" || entries.id || "%"';
    if (aFeedId)
      feedIdCondition = 'AND "' + aFeedId + '" LIKE "%" || entries.feedId || "%"';

    // If an id was specified, get the entry regardless of its deleted status.
    if (aEntryId)
      deletedCondition = '';
    // Otherwise the default deleted condition is "not deleted".
    else
      deletedCondition = ' AND entries.deleted = 0 ';

    if (aRules) {
      if (aRules.match('unread'))
        readCondition += ' AND entries.read = 0 ';
      if (aRules.match(/ read|^read/))
        readCondition += ' AND entries.read = 1 ';

      if (aRules.match('unstarred'))
        starredCondition += ' AND entries.starred = 0 ';
      if (aRules.match(/ starred|^starred/))
        starredCondition += ' AND entries.starred = 1 ';

      if (aRules.match('trashed'))
        deletedCondition = ' AND entries.deleted = 1 ';
    }

    if (aMode == 'full')
      orderByClause = ' ORDER BY date DESC ';

    if (aSearchString)
      searchFilter = ' AND entries.title || entries.summary || entries.content' +
                     ' LIKE "%" || "' + aSearchString + '" || "%" ';

    if (aLimit)
      limitClause = 'LIMIT ' + aLimit;
    if (aOffset)
      offsetClause = 'OFFSET ' + aOffset;

    var statement = statement.replace('_columnList_',       columnList);
    var statement = statement.replace('_entryIdCondition_', entryIdCondition);
    var statement = statement.replace('_feedIdCondition_',  feedIdCondition);
    var statement = statement.replace('_readCondition_',    readCondition);
    var statement = statement.replace('_starredCondition_', starredCondition);
    var statement = statement.replace('_deletedCondition_', deletedCondition);
    var statement = statement.replace('_orderByClause_',    orderByClause);
    var statement = statement.replace('_searchFilter_',     searchFilter);
    var statement = statement.replace('_limitClause_',      limitClause);
    var statement = statement.replace('_offsetClause_',     offsetClause);

    return this.dBConnection.createStatement(statement);
  },


  // nsIBriefStorage
  updateFeed: function(aFeed) {
    // Invalidate cache since feeds table is about to change.
    this.feedsCache = null;

    var hasher = Cc['@mozilla.org/security/hash;1'].
                 createInstance(Ci.nsICryptoHash);

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
    var oldUnreadCount = this.getEntriesCount(aFeed.feedId, 'unread');
    try {
      //dump('Updating feed ' + aFeed.title + '\n');
      for each (entry in aFeed.getEntries({})) {
        var id = this.hashString(entry.entryURL + entry.title + entry.date);

        insertIntoEntries.bindStringParameter(0, aFeed.feedId);
        insertIntoEntries.bindStringParameter(1, id);
        insertIntoEntries.bindStringParameter(2, entry.entryURL);
        insertIntoEntries.bindStringParameter(3, entry.title);
        insertIntoEntries.bindStringParameter(4, entry.summary);
        insertIntoEntries.bindStringParameter(5, entry.content);
        insertIntoEntries.bindInt64Parameter(6, entry.date ? entry.date :
                                                             Date.now());
        insertIntoEntries.bindInt32Parameter(7, 0);
        insertIntoEntries.execute();
      }

      // Do not update title, so that it is always taken from the Live Bookmark
      var update = this.dBConnection.
                   createStatement('UPDATE feeds SET    ' +
                                   'websiteURL  = ?1,   ' +
                                   'subtitle    = ?2,   ' +
                                   'imageURL    = ?3,   ' +
                                   'imageLink   = ?4,   ' +
                                   'imageTitle  = ?5,   ' +
                                   'favicon     = ?6,   ' +
                                   'everUpdated = 1     ' +
                                   'WHERE feedId = ?7  ');
      update.bindStringParameter(0, aFeed.websiteURL);
      update.bindStringParameter(1, aFeed.subtitle);
      update.bindStringParameter(2, aFeed.imageURL);
      update.bindStringParameter(3, aFeed.imageLink);
      update.bindStringParameter(4, aFeed.imageTitle);
      update.bindStringParameter(5, aFeed.favicon);
      update.bindStringParameter(6, aFeed.feedId);
      update.execute();
    }
    finally {
      this.dBConnection.commitTransaction();
    }

    // Notify if there were any updates to the feed
    var newUnreadCount = this.getEntriesCount(aFeed.feedId, 'unread');
    var newEntriesCount = newUnreadCount - oldUnreadCount;
    var subject = Cc["@mozilla.org/variant;1"].
                  createInstance(Ci.nsIWritableVariant);
    subject.setAsInt32(newEntriesCount);
    this.observerService.notifyObservers(subject, 'brief:feed-updated',
                                         aFeed.feedId);
  },


  // nsIBriefStorage
  markEntriesRead: function(aNewStatus, aEntryId, aFeedId, aRules) {
    // This is the template for our statement.
    var statement = 'UPDATE entries SET read = ?  WHERE   ' +
                    '_deletedCondition_                   ' +
                    '_entryIdCondition_                   ' +
                    '_feedIdCondition_                   ' +
                    '_readCondition_                      ' +
                    '_starredCondition_                   ' ;

    var entryIdCondition = feedIdCondition = readCondition = starredCondition =
        deletedCondition = '';

    if (aEntryId)
      entryIdCondition = 'AND "' + aEntryId + '" LIKE "%" || entries.id || "%"';
    if (aFeedId)
      feedIdCondition = 'AND "' + aFeedId + '" LIKE "%" || entries.feedId || "%"';

    deletedCondition = ' entries.deleted LIKE "%"';

    if (aRules) {
      if (aRules.match('unread'))
        readCondition += ' AND entries.read = 0 ';
      if (aRules.match(/ read|^read/))
        readCondition += ' AND entries.read = 1 ';

      if (aRules.match('unstarred'))
        starredCondition += ' AND entries.starred = 0 ';
      if (aRules.match(/ starred|^starred/))
        starredCondition += ' AND entries.starred = 1 ';

      if (aRules.match('trashed'))
        deletedCondition = ' entries.deleted = 1 ';
    }

    var statement = statement.replace('_entryIdCondition_', entryIdCondition);
    var statement = statement.replace('_feedIdCondition_',  feedIdCondition);
    var statement = statement.replace('_readCondition_',    readCondition);
    var statement = statement.replace('_starredCondition_', starredCondition);
    var statement = statement.replace('_deletedCondition_', deletedCondition);

    var update = this.dBConnection.createStatement(statement)
    update.bindInt32Parameter(0, aNewStatus ? 1 : 0);

    this.dBConnection.beginTransaction();
    try {
      // Get the list of entries which are about to change, so the notification
      // can provide it.
      var rule = aNewStatus ? 'unread' : 'read';
      var changedEntries = this.getSerializedEntries(aEntryId, aFeedId,
                                                     aRules + ' ' + rule);
      update.execute();
    }
    finally {
      this.dBConnection.commitTransaction();
    }

    this.observerService.notifyObservers(changedEntries,
                                         'brief:entry-status-changed',
                                         aNewStatus ? 'read' : 'unread');
  },


  // nsIBriefStorage
  deleteEntries: function(aEntryId, aNewStatus) {
    var update = this.dBConnection.
        createStatement('UPDATE entries SET deleted = ? WHERE ' +
                        '? LIKE "%" || id || "%"              ');
    update.bindInt32Parameter(0, aNewStatus);
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


  // nsIObserver
  observe: function(aSubject, aTopic, aData) {
    if (aTopic != 'nsPref:changed')
      return;
    switch (aData) {
      case 'liveBookmarksFolder':
        this.syncWithBookmarks();
        break;
    }
  },


  // nsIBriefStorage
  syncWithBookmarks: function() {
    if (!this.livemarksInitiated)
      this.initLivemarks();

    this.livemarks = new Array();

    // Get the current Live Bookmarks
    var rootID = this.briefPrefs.getCharPref('liveBookmarksFolder');
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
          createStatement('INSERT OR IGNORE INTO feeds                  ' +
                          '(feedId, feedURL, title)                     ' +
                          'VALUES(?1, ?2, ?3)                           ');
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
    this.rdfs = Cc['@mozilla.org/rdf/rdf-service;1'].
                getService(Ci.nsIRDFService);
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
    if (!this.dBConnection.tableExists('dummy_table'))
      this.dBConnection.
           executeSimpleSQL('CREATE TABLE dummy_table (id INTEGER PRIMARY KEY)');

    // This table is guaranteed to have something in it and will keep the dummy
    // statement open. If the table is empty, it won't hold the statement open.
    this.dBConnection.
         executeSimpleSQL('INSERT OR IGNORE INTO dummy_table VALUES (1)');

    var dummyStatement = this.dummyDBConnection.
                         createStatement('SELECT id FROM dummy_table LIMIT 1');

    // We have to step the dummy statement so that it will hold a lock on the DB
    dummyStatement.executeStep();
  },


  hashString: function(aString) {
    var hasher = Cc['@mozilla.org/security/hash;1'].
                 createInstance(Ci.nsICryptoHash);

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
        !aIID.equals(Components.interfaces.nsIObserver))
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
