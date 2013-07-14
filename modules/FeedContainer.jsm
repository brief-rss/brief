const EXPORTED_SYMBOLS = ['Feed', 'Entry', 'EntryList'];

Components.utils.import('resource://brief/common.jsm');

IMPORT_COMMON(this);

/**
 * Container for feed properties.
 */
function Feed() { }

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
     * Feed's preferences.
     */
    entryAgeLimit:  0,
    maxEntries:     0,
    updateInterval: 0,
    markModifiedEntriesUnread: false,
    omitInUnread: 0,

    /**
     * Date of the oldest entry that was available
     * when the feed was checked for updates.
     */
    oldestEntryDate: 0,

    /**
     * Indicates if feed is active, i.e. can be found in the home folder.
     * The value is 0 if the feed is active, otherwise it indicates the time
     * when it was set to inactive.
     */
    hidden: 0,

    /**
     * The wrapped nsIFeed.
     */
    wrappedFeed: null,

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

    if (aEntry.published)
        this.date = new RFC822Date(aEntry.published).getTime();

    if (aEntry.updated)
        this.updated = new RFC822Date(aEntry.updated).getTime();

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
    entryURL:  '',
    title:     '',
    summary:   '',
    content:   '',
    published:  0,
    updated:    0,
    authors:   '',

    /**
     * Status information.
     */
    read:     false,
    starred:  false,
    markedUnreadOnUpdate: false,

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
    let date = new Date(aDateString);

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
let milTimezoneCodesMap = {
    A: '-1',  B: '-2',  C: '-3',  D: '-4', E: '-5',  F: '-6',  G: '-7',  H: '-8', I: '-9',
    K: '-10', L: '-11', M: '-12', N: '+1', O: '+2',  P: '+3',  Q: '+4',  R: '+5',
    S: '+6',  T: '+7',  U: '+8',  V: '+9', W: '+10', X: '+11', Y: '+12', Z: 'UT',
}
