const Cc = Components.classes;
const Ci = Components.interfaces;

const MAX_SQL_EXPRESSION_SIZE = 950;

Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

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
    entries: null,

    entryAgeLimit:  0,
    maxEntries:     0,
    updateInterval: 0,
    markModifiedEntriesUnread: false,

    oldestEntryDate: 0,

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
            this.entries = [];
            for (var i = 0; i < aFeed.items.length; i++) {
                var entry = aFeed.items.queryElementAt(i, Ci.nsIFeedEntry);
                var wrappedEntry = Cc['@ancestor/brief/feedentry;1'].
                                   createInstance(Ci.nsIBriefFeedEntry);
                wrappedEntry.wrapEntry(entry);
                this.entries.push(wrappedEntry);
            }
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
    id:       0,

    entryURL: '',
    title:    '',
    summary:  '',
    content:  '',
    date:     0,
    authors:  '',

    read:     false,
    starred:  false,
    updated:  false,

    bookmarkID: -1,
    tags: null,

    wrappedEntry: null,

    wrapEntry: function BriefFeedEntry_wrapEntry(aEntry) {
        this.wrappedEntry = aEntry;

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


// nsBriefFeed class definition
function EntryList() { }

EntryList.prototype = {

    get length() this.IDs ? this.IDs.length : 0,

    // nsIBriefEntryList
    IDs:   null,

    feeds: null,
    tags:  null,


    containsFeed: function EntryList_containsFeed(aFeedID) {
        return this.feeds.indexOf(aFeedID) != -1;
    },

    containsTagged: function EntryList_containsTagged(aTagName) {
        return this.tags.indexOf(aTagName) != -1;
    },

    containsUnread: function EntryList_containsUnread() {
        return this.contains('unread');
    },

    containsStarred: function EntryList_containsStarred() {
        return this.contains('starred');
    },

    containsTrashed: function EntryList_containsTrashed() {
        return this.contains('trashed');
    },


    contains: function EntryList_contains(aWhat) {
        if (this.length > MAX_SQL_EXPRESSION_SIZE)
            return true;

        var query = Cc['@ancestor/brief/query;1'].createInstance(Ci.nsIBriefQuery);
        query.entries = this.IDs;
        switch (aWhat) {
            case 'unread':
                query.unread = true;
                break;
            case 'starred':
                query.starred = true;
                break;
            case 'trashed':
                query.deleted = Ci.nsIBriefQuery.ENTRY_STATE_TRASHED;
                break;
        }

        return query.hasMatches();
    },


    classDescription: 'A simple list of feed entries',
    classID: Components.ID('{9a853d20-203d-11dd-bd0b-0800200c9a66}'),
    contractID: '@ancestor/brief/entrylist;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIBriefEntryList])

}

var modules = [Feed, FeedEntry, EntryList];
function NSGetModule(compMgr, fileSpec) XPCOMUtils.generateModule(modules)
