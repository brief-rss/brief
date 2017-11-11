const EXPORTED_SYMBOLS = ['FEEDS_TABLE_SCHEMA', 'ENTRIES_TABLE_SCHEMA', 'ENTRIES_TEXT_TABLE_SCHEMA',
                    'ENTRY_TAGS_TABLE_SCHEMA'];

/* All dates are in miliseconds since the Unix epoch */

/* This table stores feeds (Live Bookmarks) and folders found in the home folder.
 * Folders are distinguished by isFolder flag and don't use most of the columns.
 */
const FEEDS_TABLE_SCHEMA = [
    // Unique feed ID: MD5 hash of the feed's URL.
    { 'name': 'feedID', 'type': 'TEXT UNIQUE' },

    // URL and title are taken from the Live Bookmark.
    { 'name': 'feedURL', 'type': 'TEXT' },
    { 'name': 'title',   'type': 'TEXT' },

    // Properties parsed from the feed itself.
    { 'name': 'websiteURL',   'type': 'TEXT' },
    { 'name': 'subtitle',     'type': 'TEXT' },
    { 'name': 'language',     'type': 'TEXT' },
    { 'name': 'dateModified', 'type': 'INTEGER', 'default': 0 },

    // data: URL containing a base64-encoded favicon image.
    { 'name': 'favicon', 'type': 'TEXT' },

    // Numeric ID of the corresponding item in the Places database.
    { 'name': 'bookmarkID', 'type': 'TEXT' },

    // Numeric ID of the parent folder in the Places database.
    { 'name': 'parent', 'type': 'TEXT' },

    // Index is relative to the home folder root,
    // not necessarily to the direct parent.
    { 'name': 'rowIndex', 'type': 'INTEGER', },

    // Boolean flag.
    { 'name': 'isFolder', 'type': 'INTEGER', },

    // Date of when the feed was deleted from the home folder, or 0 if still present.
    // Hidden feeds are purged after the amount of time specified by the constant
    // DELETED_FEEDS_RETENTION_TIME.
    { 'name': 'hidden', 'type': 'INTEGER', 'default': 0 },

    // Date of the last time the feed was checked for updates.
    { 'name': 'lastUpdated', 'type': 'INTEGER', 'default': 0 },

    // Date of the last time the favicon was fetched.
    { 'name': 'lastFaviconRefresh', 'type': 'INTEGER', 'default': 0 },

     // Date of the oldest entry currently available on the servcer. Used when purging.
     // Deleted items that are still available cannot be purged because they would be
     // recognized as new on the following update.
    { 'name': 'oldestEntryDate', 'type': 'INTEGER' },


    /* User-defined settings.*/

    // Age in miliseconds after which entries are moved to trash. Zero means no
    // feed-specific limit (a global limit may still apply).
    { 'name': 'entryAgeLimit', 'type': 'INTEGER', 'default': 0 },

    // After exceeding this number, oldest entries will be moved to trash.
    // Zero means no feed-specific limit.
    { 'name': 'maxEntries', 'type': 'INTEGER', 'default': 0 },

    // Time in miliseconds, how often to check the feed for updates.
    { 'name': 'updateInterval', 'type': 'INTEGER', 'default': 0 },

    // Boolean flag. Indicates whether entries that have already been downloaded
    // and marked as read should be marked as unread again when they are modified
    // on the server.
    { 'name': 'markModifiedEntriesUnread', 'type': 'INTEGER', 'default': 1 },

    // Boolean flag. This is a misnomer, should be called omitInGlobalViews.
    // Indicates whether the feed's entries should be included in global views,
    // i.e. Today and All Items.
    { 'name': 'omitInUnread', 'type': 'INTEGER', 'default': 0 },

    // 0 - full view, 1 - headlines view
    { 'name': 'viewMode', 'type': 'INTEGER', 'default': 0 }

]


const ENTRIES_TABLE_SCHEMA = [
    { 'name': 'id',            'type': 'INTEGER PRIMARY KEY AUTOINCREMENT' },

    // Foreign key.
    { 'name': 'feedID',        'type': 'TEXT' },

    // The primary hash is used as a standard unique ID throughout the codebase.
    // Ideally, we just compute it from the GUID provided by the feed. Otherwise, we
    // use the entry's URL.
    // There is a problem, though. Even when a feed does provide its own GUID, it
    // seems to randomly get lost (maybe a bug in the parser?). This means that the
    // same entry may sometimes be hashed using the GUID and other times using the
    // URL. Different hashes lead to the entry being duplicated.
    // This is why we need a secondary hash, which is always based on the URL. If the
    // GUID is empty (either because it was lost or because it wasn't provided to
    // begin with), we look up the entry using the secondary hash.
    { 'name': 'primaryHash',   'type': 'TEXT' },
    { 'name': 'secondaryHash', 'type': 'TEXT' },

    // The entry ID provided by the feed itself.
    { 'name': 'providedID',    'type': 'TEXT' },

    { 'name': 'entryURL',      'type': 'TEXT' },

    // Publication date.
    { 'name': 'date',         'type': 'INTEGER' },

    // Date the entry was last updated (modified) on the server.
    { 'name': 'updated',       'type': 'INTEGER' },

    // 0 - unread, 1 - read, 2 - re-marked unread after entry was updated
    // (see markModifiedEntriesUnread in the feeds table).
    { 'name': 'read',         'type': 'INTEGER', 'default': 0 },

    // Boolean flag.
    { 'name': 'starred',       'type': 'INTEGER', 'default': 0 },

    // Deleted state: 0 - normal, 1 - in trash, 2 - deleted (awaiting to be
    // purged, see oldestEntryDate in the feeds table).
    { 'name': 'deleted',       'type': 'INTEGER', 'default': 0 },

    // Numeric ID of the bookmark in the Places database, if the entry is starred.
    { 'name': 'bookmarkID',    'type': 'INTEGER', 'default': -1 },
]


/**
 * Virtual table created using Full-Text Search extension.
 */
const ENTRIES_TEXT_TABLE_SCHEMA = [
    { 'name': 'title',   'type': 'TEXT' },
    { 'name': 'content', 'type': 'TEXT' },
    { 'name': 'authors', 'type': 'TEXT' },

    // Serialized list of tags, generated from entry_tags table.
    { 'name': 'tags',    'type': 'TEXT' }
]


const ENTRY_TAGS_TABLE_SCHEMA = [
    { 'name': 'tagName', 'type': 'TEXT' },
    { 'name': 'entryID', 'type': 'INTEGER' }
]
