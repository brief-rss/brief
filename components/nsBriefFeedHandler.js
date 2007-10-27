const FEED_CLASS_ID = Components.ID('{33F4FF4C-7F11-11DB-83CE-09C655D89593}');
const ENTRY_CLASS_ID = Components.ID('{2B99DB2E-7F11-11DB-ABEC-E0C555D89593}');
const FEED_CLASS_NAME = 'Container for feed data';
const ENTRY_CLASS_NAME = 'Container for a single feed entry';
const FEED_CONTRACT_ID = '@ancestor/brief/feed;1';
const ENTRY_CONTRACT_ID = '@ancestor/brief/feedentry;1';

const Cc = Components.classes;
const Ci = Components.interfaces;


// nsBriefFeed class definition
function Feed() { }

Feed.prototype = {

    feedID:  '',
    feedURL: '',

    websiteURL: '',
    title:      '',
    subtitle:   '',
    imageURL:   '',
    imageLink:  '',
    imageTitle: '',

    favicon: '',

    lastUpdated: 0,

    rowIndex: 0,
    isFolder: false,
    parent:   '',

    wrappedFeed: null,
    items: null,

    entryAgeLimit:  0,
    maxEntries:     0,
    updateInterval: 0,

    oldestAvailableEntryDate: 0,

    getEntries: function BriefFeed_getEntries(entryCount) {
        entryCount.value = this.items.length;
        return this.items;
    },

    wrapFeed: function BriefFeed_wrapFeed(aFeed) {
        this.wrappedFeed = aFeed;

        if (aFeed.title)
            this.title = aFeed.title.text;
        if (aFeed.link)
            this.websiteURL = aFeed.link.spec;
        if (aFeed.subtitle)
            this.subtitle = aFeed.subtitle.text;
        if (aFeed.image) {
            try {
                this.imageURL = aFeed.image.getPropertyAsAString('url');
                this.imageLink = aFeed.image.getPropertyAsAString('link');
                this.imageTitle = aFeed.image.getPropertyAsAString('title');
            }
            catch (e) {}
        }
        if (aFeed.items) {
            var entries = [];
            for (var i = 0; i < aFeed.items.length; i++) {
                var entry = aFeed.items.queryElementAt(i, Ci.nsIFeedEntry);
                var wrappedEntry = Cc['@ancestor/brief/feedentry;1'].
                                   createInstance(Ci.nsIBriefFeedEntry);
                wrappedEntry.wrapEntry(entry);
                entries.push(wrappedEntry);
            }
            this.items = entries;
        }
    },

    QueryInterface: function BriefFeed_QueryInterface(aIID) {
        if (!aIID.equals(Components.interfaces.nsIBriefFeed) &&
            !aIID.equals(Components.interfaces.nsISupports))
            throw Components.results.NS_ERROR_NO_INTERFACE;
        return this;
    }

}


// nsBriefFeedEntry class definition
function FeedEntry() { }

FeedEntry.prototype = {

    feedID:   '',
    id:       '',
    entryURL: '',
    title:    '',
    summary:  '',
    content:  '',
    date:     0,
    authors:  '',
    read:     false,
    starred:  false,
    updated:  false,

    wrappedEntry: null,

    wrapEntry: function BriefFeedEntry_wrapEntry(aEntry) {
        this.wrappedEntry = aEntry;

        if (aEntry.id)
            this.id = aEntry.id;

        if (aEntry.title)
            this.title = aEntry.title.text;

        if (aEntry.link)
            this.entryURL = aEntry.link.spec;

        if (aEntry.summary)
            this.summary = aEntry.summary.text;

        if (aEntry.content)
            this.content = aEntry.content.text;

        // We prefer |updated| to |published|
        if (aEntry.updated)
            this.date = new Date(aEntry.updated).getTime();
        else if (aEntry.published)
            this.date = new Date(aEntry.published).getTime();

        try {
            if (aEntry.authors) {
                var authors = [], author;
                for (var i = 0; i < aEntry.authors.length; i++) {
                    author = aEntry.authors.queryElementAt(i, Ci.nsIFeedPerson).name;
                    authors.push(author);
                }
                this.authors = authors.join(', ');
            }
        }
        catch (e) {
            // XXX On some feeds accessing nsIFeedContainer.authors throws.
        }
    },

    QueryInterface: function BriefFeedEntry_QueryInterface(aIID) {
      if (!aIID.equals(Components.interfaces.nsIBriefFeedEntry) &&
          !aIID.equals(Components.interfaces.nsISupports))
          throw Components.results.NS_ERROR_NO_INTERFACE;
      return this;
    }

}



function Factory(aInterface) {
    this._interface = aInterface;
}

Factory.prototype = {

    createInstance: function(aOuter, aIID) {
        if (aOuter != null)
            throw Components.results.NS_ERROR_NO_AGGREGATION;

      return (new this._interface()).QueryInterface(aIID);
    }

}

// Module definition (xpcom registration)
var Module = {
    _firstTime: true,

    registerSelf: function(aCompMgr, aFileSpec, aLocation, aType) {
        aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
        aCompMgr.registerFactoryLocation(FEED_CLASS_ID, FEED_CLASS_NAME, FEED_CONTRACT_ID,
                                         aFileSpec, aLocation, aType);
        aCompMgr.registerFactoryLocation(ENTRY_CLASS_ID, ENTRY_CLASS_NAME, ENTRY_CONTRACT_ID,
                                         aFileSpec, aLocation, aType);
    },

    unregisterSelf: function(aCompMgr, aLocation, aType) {
        aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
        aCompMgr.unregisterFactoryLocation(FEED_CLASS_ID, aLocation);
        aCompMgr.unregisterFactoryLocation(ENTRY_CLASS_ID, aLocation);
    },

    getClassObject: function(aCompMgr, aCID, aIID) {
        if (!aIID.equals(Components.interfaces.nsIFactory))
            throw Components.results.NS_ERROR_NOT_IMPLEMENTED;

        if (aCID.equals(FEED_CLASS_ID))
            return new Factory(Feed);
        if (aCID.equals(ENTRY_CLASS_ID))
            return new Factory(FeedEntry);

        throw Components.results.NS_ERROR_NO_INTERFACE;
    },

    canUnload: function(aCompMgr) { return true; },

}

// Module initialization
function NSGetModule(aCompMgr, aFileSpec) { return Module; }

function dump(aMessage) {
  var consoleService = Cc["@mozilla.org/consoleservice;1"].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n' + aMessage);
}