const F_CLASS_ID = Components.ID("{33F4FF4C-7F11-11DB-83CE-09C655D89593}");
const A_CLASS_ID = Components.ID("{2B99DB2E-7F11-11DB-ABEC-E0C555D89593}");
const F_CLASS_NAME = "Container for feed data";
const A_CLASS_NAME = "Container for a single feed entry";
const F_CONTRACT_ID = "@mozilla.org/brief/feed;1";
const A_CONTRACT_ID = "@mozilla.org/brief/feedentry;1";

const Cc = Components.classes;
const Ci = Components.interfaces;


// nsBriefFeed class definition
function Feed() { };

Feed.prototype = {
  
  feedId:        '',
  feedURL:       '',
  websiteURL:    '',
  title:         '',
  subtitle:      '',
  imageURL:      '',
  imageLink:     '',
  imageTitle:    '',
  favicon:       '',
  everUpdated:   false,
  items:         null,
  
  getEntries: function(entryCount) {
    entryCount.value = this.items.length;
    return this.items;
  },
  
  wrapFeed: function(aFeed) {
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
      var entries = new Array();
      for (var i = 0; i < aFeed.items.length; i++) {
        var entry = aFeed.items.queryElementAt(i, Ci.nsIFeedEntry);
        var wrappedEntry = Cc['@mozilla.org/brief/feedentry;1'].
                           createInstance(Ci.nsIBriefFeedEntry);
        wrappedEntry.wrapEntry(entry);
        entries.push(wrappedEntry);
      }
      this.items = entries;
    }
  },
  
  QueryInterface: function(aIID) {
    if (!aIID.equals(Components.interfaces.nsIBriefFeed) && 
        !aIID.equals(Components.interfaces.nsISupports))
      throw Components.results.NS_ERROR_NO_INTERFACE;
    return this;
  }

};


// nsBriefFeedEntry class definition
function FeedEntry() { };

FeedEntry.prototype = {
  
  feedId:     '',
  id:         '',
  entryURL:   '',
  title:      '',
  summary:    '',
  content:    '',
  date:       0,
  read:       false,
  starred:    false,
  
  wrapEntry: function(aEntry) {
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
  },
  
  QueryInterface: function(aIID) {
    if (!aIID.equals(Components.interfaces.nsIBriefFeedEntry) &&
        !aIID.equals(Components.interfaces.nsISupports))
      throw Components.results.NS_ERROR_NO_INTERFACE;
    return this;
  }

}



function Factory(aInterface) {
  this._interface = aInterface;
};

Factory.prototype = {
  
  createInstance: function(aOuter, aIID) {
    if (aOuter != null)
      throw Components.results.NS_ERROR_NO_AGGREGATION;
    return (new this._interface()).QueryInterface(aIID);
  }
  
};

// Module definition (xpcom registration)
var Module = {
  _firstTime: true,
  
  registerSelf: function(aCompMgr, aFileSpec, aLocation, aType) {
    aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
    aCompMgr.registerFactoryLocation(F_CLASS_ID, F_CLASS_NAME, F_CONTRACT_ID, 
                                     aFileSpec, aLocation, aType);
    aCompMgr.registerFactoryLocation(A_CLASS_ID, A_CLASS_NAME, A_CONTRACT_ID, 
                                     aFileSpec, aLocation, aType);
  },

  unregisterSelf: function(aCompMgr, aLocation, aType) {
    aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
    aCompMgr.unregisterFactoryLocation(F_CLASS_ID, aLocation);
    aCompMgr.unregisterFactoryLocation(A_CLASS_ID, aLocation);
  },
  
  getClassObject: function(aCompMgr, aCID, aIID) {
    if (!aIID.equals(Components.interfaces.nsIFactory))
      throw Components.results.NS_ERROR_NOT_IMPLEMENTED;

    if (aCID.equals(F_CLASS_ID))
      return new Factory(Feed);
    if (aCID.equals(A_CLASS_ID))
      return new Factory(FeedEntry);

    throw Components.results.NS_ERROR_NO_INTERFACE;
  },

  canUnload: function(aCompMgr) { return true; },

};

// Module initialization
function NSGetModule(aCompMgr, aFileSpec) { return Module; }
