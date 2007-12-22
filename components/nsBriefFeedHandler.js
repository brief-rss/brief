const Cc = Components.classes;
const Ci = Components.interfaces;

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

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
    dateModified: 0,

    favicon: '',

    lastUpdated: 0,

    bookmarkID: '',
    rowIndex: 0,
    isFolder: false,
    parent:   '',

    wrappedFeed: null,
    items: null,

    entryAgeLimit:  0,
    maxEntries:     0,
    updateInterval: 0,

    oldestEntryDate: 0,

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

    classDescription: 'Container for feed data',
    classID: Components.ID('{33F4FF4C-7F11-11DB-83CE-09C655D89593}'),
    contractID: '@ancestor/brief/feed;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIBriefFeed])

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
            // XXX With some feeds accessing nsIFeedContainer.authors throws.
        }
    },

    classDescription: 'Container for a single feed entry',
    classID: Components.ID('{2B99DB2E-7F11-11DB-ABEC-E0C555D89593}'),
    contractID: '@ancestor/brief/feedentry;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIBriefFeedEntry])

}


function dump(aMessage) {
  var consoleService = Cc["@mozilla.org/consoleservice;1"].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n' + aMessage);
}


function NSGetModule(compMgr, fileSpec) XPCOMUtils.generateModule([Feed, FeedEntry])
