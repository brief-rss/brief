const Cc = Components.classes;
const Ci = Components.interfaces;

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
            // Counting down, because the order of items is reversed after parsing.
            for (let i = aFeed.items.length - 1; i >= 0; i--) {
                let entry = aFeed.items.queryElementAt(i, Ci.nsIFeedEntry);
                let wrappedEntry = Cc['@ancestor/brief/feedentry;1'].
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

        if (aEntry.updated)
            this.date = new RFC822Date(aEntry.updated).getTime();
        else if (aEntry.published)
            this.date = new RFC822Date(aEntry.published).getTime();

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


// nsIBriefEntryList class definition
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
        // Maximum depth of expression tree in sqlite is 1000, so there are only
        // so many entries you can OR in a statement. If that limit is exceeded,
        // we return true even though we don't know if there were any matches.
        // nsIBriefEntryList.contains() is used primarly by views and it's better
        // for them to be unnecessarily refreshed than not be refreshed when they should.
        if (this.length > 500)
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


function RFC822Date(aDateString) {
    var date = new Date(aDateString);

    // If the date is invalid, it may be caused by the fact that the built-in date parser
    // doesn't handle military timezone codes, even though they are part of RFC822.
    // We can fix this by manually replacing the military timezone code with the actual
    // timezone.
    if (date.toString().match('invalid','i')) {
        let codeArray = aDateString.match('\\s[a-ik-zA-IK-Z]$');
        if (codeArray) {
            let timezoneCode = codeArray[0];
            // Strip whitespace and normalize to upper case.
            timezoneCode = timezoneCode.replace(/^\s+/,'')[0].toUpperCase();
            let timezone = militaryTimezoneCodes[timezoneCode];
            let fixedDateString = aDateString.replace(/\s[a-ik-zA-IK-Z]$/, ' ' + timezone);
            date = new Date(fixedDateString);
        }

        // If the date is still invalid, just use the current date.
        if (date.toString().match('invalid','i'))
            date = new Date(fixedDateString);
    }

    return date;
}

// Conversion table for military coded timezones.
var militaryTimezoneCodes = {
    A: '-1',  B: '-2',  C: '-3',  D: '-4', E: '-5',  F: '-6',  G: '-7',  H: '-8', I: '-9',
    K: '-10', L: '-11', M: '-12', N: '+1', O: '+2',  P: '+3',  Q: '+4',  R: '+5',
    S: '+6',  T: '+7',  U: '+8',  V: '+9', W: '+10', X: '+11', Y: '+12', Z: 'UT',
}


function log(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage(aMessage);
}

var modules = [Feed, FeedEntry, EntryList];
function NSGetModule(compMgr, fileSpec) XPCOMUtils.generateModule(modules)
