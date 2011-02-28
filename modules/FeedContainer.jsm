const EXPORTED_SYMBOLS = ['Feed', 'Entry', 'EntryList'];

Components.utils.import('resource://brief/common.jsm');

IMPORT_COMMON(this);

/**
 * Container for feed properties. You can pass an instance of nsIFeed to wrap
 * and map some of its selected properties for easier access.
 *
 * @param aFeed [optional]
 *        nsIFeed to wrap.
 */
function Feed(aFeed) {
    if (!aFeed)
        return;

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
            this.entries.push(new Entry(entry));
        }
    }
}

Feed.prototype = {

    /**
     * Unique string identifying an entry in Brief's database.
     */
    feedID:  '',

    /**
     * Feed's properties.
     */
    feedURL: '',
    websiteURL: '',
    title:      '',
    subtitle:   '',
    imageURL:   '',
    imageLink:  '',
    imageTitle: '',
    dateModified: 0,

    /**
     * base64-encoded data: URI of the favicon of the site under websiteURL.
     */
    favicon: '',

    /**
     * Date when the feed was last checked for updates.
     */
    lastUpdated: 0,

    /**
     * Date when the feed's favicon was last refreshed.
     */
    lastFaviconRefresh: 0,

    /**
     * ID of the Live Bookmark.
     */
    bookmarkID: '',

    /**
     * Index of the feed's Live Bookmark relative to the Brief's home folder
     * (not to the Live Bookmark's direct parent).
     */
    rowIndex: 0,
    isFolder: false,

    /**
     * feedID of the parent folder.
     */
    parent:   '',

    /**
     * The wrapped nsIFeed.
     */
    wrappedFeed: null,

    /**
     * Entries from the wrapped nsIFeed, array of Entry objects.
     */
    entries: null,

    /**
     * Feed's preferences.
     */
    entryAgeLimit:  0,
    maxEntries:     0,
    updateInterval: 0,
    markModifiedEntriesUnread: false,

    /**
     * Date of the oldest entry that was available
     * when the feed was checked for updates.
     */
    oldestEntryDate: 0

}


/**
 * Container for feed entry data.
 *
 * @param aEntry [optional]
 *        nsIFeedEntry object to wrap.
 */

function Entry(aEntry) {
    if (!aEntry)
        return;

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
            let authors = [];
            for (let i = 0; i < aEntry.authors.length; i++) {
                let author = aEntry.authors.queryElementAt(i, Ci.nsIFeedPerson).name;
                authors.push(author);
            }
            this.authors = authors.join(', ');
        }
    }
    catch (e) {
        // With some feeds accessing nsIFeedContainer.authors throws.
    }
}

Entry.prototype = {

    /**
     * Unique number identifying an entry in Brief's database.
     */
    id: 0,

    /**
     * ID of feed to which the entry belongs.
     */
    feedID: '',

    /**
     * Entry's data.
     */
    entryURL: '',
    title:    '',
    summary:  '',
    content:  '',
    date:     0,
    authors:  '',

    /**
     * Status information.
     */
    read:     false,
    starred:  false,
    updated:  false,

    /**
     * ID if the corresponing bookmark, or -1 if entry isn't bookmarked.
     */
    bookmarkID: -1,

    /**
     * Array of tags associated with the entry's URI.
     */
    tags: null,

    /**
     * Wrapped nsIFeedEntry.
     */
    wrappedEntry: null

}


/**
 * A simple list of entries.
 */
function EntryList() { }

EntryList.prototype = {

    /**
     * Number of entries in the list.
     */
    get length() this.IDs ? this.IDs.length : 0,

    /**
     * Array of entry IDs.
     */
    IDs: null,

    /**
     * Array of distinct feeds to which entries in the list belong.
     */
    feeds: null,

    /**
     * Array of distinct tags which entries in the list have.
     */
    tags: null

}


function RFC822Date(aDateString) {
    var date = new Date(aDateString);

    // If the date is invalid, it may be caused by the fact that the built-in date parser
    // doesn't handle military timezone codes, even though they are part of RFC822.
    // We can fix this by manually replacing the military timezone code with the actual
    // timezone.
    if (date.toString().match('invalid','i')) {
        let timezoneCodes = aDateString.match(/\s[a-ik-zA-IK-Z]$/);
        if (timezoneCodes) {
            let timezoneCode = timezoneCodes[0];
            // Strip whitespace and normalize to upper case.
            timezoneCode = timezoneCode.replace(/^\s+/,'')[0].toUpperCase();
            let timezone = milTimezoneCodesMap[timezoneCode];
            let fixedDateString = aDateString.replace(/\s[a-ik-zA-IK-Z]$/, ' ' + timezone);
            date = new Date(fixedDateString);
        }

        // If the date is still invalid, just use the current date.
        if (date.toString().match('invalid','i'))
            date = new Date();
    }

    return date;
}

// Conversion table for military coded timezones.
var milTimezoneCodesMap = {
    A: '-1',  B: '-2',  C: '-3',  D: '-4', E: '-5',  F: '-6',  G: '-7',  H: '-8', I: '-9',
    K: '-10', L: '-11', M: '-12', N: '+1', O: '+2',  P: '+3',  Q: '+4',  R: '+5',
    S: '+6',  T: '+7',  U: '+8',  V: '+9', W: '+10', X: '+11', Y: '+12', Z: 'UT',
}
