const NC_NAME    = 'http://home.netscape.com/NC-rdf#Name';
const NC_FEEDURL = 'http://home.netscape.com/NC-rdf#FeedURL';

Ci = Components.interfaces;
Cc = Components.classes;

const gPlacesEnabled = 'nsINavHistoryService' in Ci;

var gFeed = null;
var gStorageService = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
var gPrefs = Cc['@mozilla.org/preferences-service;1'].getService(Ci.nsIPrefService).
                                                      getBranch('extensions.brief.');

function setupWindow() {
    var nameTextbox = document.getElementById('feed-name-textbox');
    var urlTextbox = document.getElementById('feed-url-textbox');
    var expirationCheckbox = document.getElementById('expiration-checkbox');
    var expirationTextbox = document.getElementById('expiration-textbox');
    var maxEntriesCheckbox = document.getElementById('max-entries-checkbox');
    var maxEntriesTextbox = document.getElementById('max-entries-textbox');
    var checkUpdatesCheckbox = document.getElementById('check-updates-checkbox');
    var checkUpdatesTextbox = document.getElementById('check-updates-textbox');
    var checkUpdatesMenulist = document.getElementById('update-time-menulist');

    if (!gFeed) {
        var feedID = window.arguments[0];
        gFeed = gStorageService.getFeed(feedID);
    }

    var stringbundle = document.getElementById('main-bundle');
    var string = stringbundle.getFormattedString('feedPropertiesDialogTitle', [gFeed.title]);
    document.title = string;

    nameTextbox.value = gFeed.title;
    urlTextbox.value = gFeed.feedURL;

    expirationCheckbox.checked = (gFeed.entryAgeLimit > 0);
    expirationTextbox.disabled = !expirationCheckbox.checked;
    expirationTextbox.value = gFeed.entryAgeLimit || gPrefs.getIntPref('database.entryExpirationAge');

    maxEntriesCheckbox.checked = (gFeed.maxEntries > 0);
    maxEntriesTextbox.disabled = !maxEntriesCheckbox.checked;
    maxEntriesTextbox.value = gFeed.maxEntries || gPrefs.getIntPref('database.maxStoredEntries');

    checkUpdatesCheckbox.checked = (gFeed.updateInterval > 0);
    checkUpdatesTextbox.disabled = checkUpdatesMenulist.disabled = !checkUpdatesCheckbox.checked;
    initUpdateIntervalControls();

    var allFeeds = gStorageService.getAllFeeds({});
    var currentIndex = allFeeds.indexOf(gFeed);
    var nextFeed = document.getElementById('next-feed');
    var previousFeed = document.getElementById('previous-feed');
    nextFeed.disabled = (currentIndex == allFeeds.length - 1);
    previousFeed.disabled = (currentIndex == 0);
}

function previousFeed() {
    var allFeeds = gStorageService.getAllFeeds({});

    // The reason we must re-get the feed is because the old feeds cache in
    // the storage component may have been destroyed after modifying the bookmarks
    // database in saveChanges(). In such case gFeed would be a reference to the object
    // in the destroyed cache, not in the array which we got from the above
    // getAllFeeds() call.
    gFeed = gStorageService.getFeed(gFeed.feedID);

    var currentIndex = allFeeds.indexOf(gFeed);
    if (currentIndex > 0) {
        saveChanges();
        gFeed = allFeeds[currentIndex - 1];
        setupWindow();
    }
}

function nextFeed() {
    var allFeeds = gStorageService.getAllFeeds({});
    // see previousFeed()
    gFeed = gStorageService.getFeed(gFeed.feedID);
    var currentIndex = allFeeds.indexOf(gFeed);
    if (currentIndex < allFeeds.length - 1) {
        saveChanges();
        gFeed = allFeeds[currentIndex + 1];
        setupWindow();
    }
}


function initUpdateIntervalControls() {
    var interval = gFeed.updateInterval / 1000 || gPrefs.getIntPref('update.interval');

    var menulist = document.getElementById('update-time-menulist');
    var textbox = document.getElementById('check-updates-textbox');

    var toDays = interval / (60*60*24);
    var toHours = interval / (60*60);
    var toMinutes = interval / 60;

    switch (true) {
        // The pref value is in seconds. If it is dividable by days then use the
        // number of days as the textbox value and select Days in the menulist.
        case Math.ceil(toDays) == toDays:
            menulist.selectedIndex = 2;
            textbox.value = toDays;
            break;
        // Analogically for hours...
        case Math.ceil(toHours) == toHours:
            menulist.selectedIndex = 1;
            textbox.value = toHours;
            break;
        // Otherwise use minutes, ceiling to the nearest integer if necessary.
        default:
            menulist.selectedIndex = 0;
            textbox.value = Math.ceil(toMinutes);
            break;
    }
}

function onExpirationCheckboxCmd(aEvent) {
    var textbox = document.getElementById('expiration-textbox');
    textbox.disabled = !aEvent.target.checked;
}

function onMaxEntriesCheckboxCmd(aEvent) {
    var textbox = document.getElementById('max-entries-textbox');
    textbox.disabled = !aEvent.target.checked;
}

function onCheckUpdatesCheckboxCmd(aEvent) {
    var textbox = document.getElementById('check-updates-textbox');
    var menulist = document.getElementById('update-time-menulist');
    textbox.disabled = menulist.disabled = !aEvent.target.checked;
}


function saveChanges() {
    var expirationCheckbox = document.getElementById('expiration-checkbox');
    var expirationTextbox = document.getElementById('expiration-textbox');
    var maxEntriesCheckbox = document.getElementById('max-entries-checkbox');
    var maxEntriesTextbox = document.getElementById('max-entries-textbox');
    var checkUpdatesCheckbox = document.getElementById('check-updates-checkbox');
    var checkUpdatesTextbox = document.getElementById('check-updates-textbox');
    var checkUpdatesMenulist = document.getElementById('update-time-menulist');

    if (expirationCheckbox.checked && expirationTextbox.value)
        gFeed.entryAgeLimit = expirationTextbox.value;
    else
        gFeed.entryAgeLimit = 0;

    if (maxEntriesCheckbox.checked && maxEntriesTextbox.value)
        gFeed.maxEntries = maxEntriesTextbox.value;
    else
        gFeed.maxEntries = 0;

    if (checkUpdatesCheckbox.checked && checkUpdatesTextbox.value) {
        var textboxValue = checkUpdatesTextbox.value;
        var intervalInMilliseconds;

        switch (checkUpdatesMenulist.selectedIndex) {
            case 0:
                // textbox.value is in minutes
                intervalInMilliseconds = textboxValue * 1000*60 ;
                break;
            case 1:
                // textbox.value is in hours
                intervalInMilliseconds = textboxValue * 1000*60*60;
                break;
            case 2:
                // textbox.value is in days
                intervalInMilliseconds = textboxValue * 1000*60*60*24;
                break;
        }

        gFeed.updateInterval = intervalInMilliseconds;
    }
    else
        gFeed.updateInterval = 0;

    gStorageService.setFeedOptions(gFeed);

    if (gPlacesEnabled)
        savePlacesLivemarksData();
    else
        saveRDFLivemarksData();

    return true;
}

function savePlacesLivemarksData() {
    var nameTextbox = document.getElementById('feed-name-textbox');
    var urlTextbox = document.getElementById('feed-url-textbox')

    var bookmarksService = Cc['@mozilla.org/browser/nav-bookmarks-service;1'].
                           getService(Ci.nsINavBookmarksService);
    var livemarkService =  Cc['@mozilla.org/browser/livemark-service;2'].
                           getService(Ci.nsILivemarkService);

    if (gFeed.title != nameTextbox.value)
        bookmarksService.setItemTitle(gFeed.bookmarkID, nameTextbox.value);

    if (gFeed.feedURL != urlTextbox.value) {
        var ioService = Cc['@mozilla.org/network/io-service;1'].
                        getService(Ci.nsIIOService);
        var uri = ioService.newURI(urlTextbox.value, null, null);
        livemarkService.setFeedURI(gFeed.bookmarkID, uri);
    }
}

function saveRDFLivemarksData() {
    var nameTextbox = document.getElementById('feed-name-textbox');
    var urlTextbox = document.getElementById('feed-url-textbox')

    if (gFeed.title == nameTextbox.value && gFeed.feedURL == urlTextbox.value)
        return;

    // We need to write values of properties that come from Live Bookmarks.
    // First, init stuff.
    var changed = false;
    initServices();
    initBMService();
    var resource = RDF.GetResource(gFeed.bookmarkID);
    var arc, newValue, oldValue;

    // Write the name.
    newValue = nameTextbox.value;
    arc = RDF.GetResource(NC_NAME)
    oldValue = BMDS.GetTarget(resource, arc, true);
    if (oldValue)
        oldValue = oldValue.QueryInterface(Ci.nsIRDFLiteral);
    if (newValue)
        newValue = RDF.GetLiteral(newValue);
    changed |= updateAttribute(arc, oldValue, newValue);


    // Write the URL.
    newValue = urlTextbox.value;
    arc = RDF.GetResource(NC_FEEDURL);
    oldValue = BMDS.GetTarget(resource, arc, true);
    if (oldValue)
        oldValue = oldValue.QueryInterface(Ci.nsIRDFLiteral);
    if (newValue && newValue.indexOf(':') < 0)
        newValue = 'http://' + newValue; // If a scheme isn't specified, use http://
    if (newValue)
        newValue = RDF.GetLiteral(newValue);
    changed |= updateAttribute(arc, oldValue, newValue);

    // If the URL was changed, clear out the favicon.
    if (oldValue && oldValue.Value != newValue.Value) {
        var icon = BMDS.GetTarget(resource, RDF.GetResource(gNC_NS + 'Icon'), true);
        if (icon)
            BMDS.Unassert(resource, RDF.GetResource(gNC_NS + 'Icon'), icon);
    }

    if (changed) {
        var remote = BMDS.QueryInterface(Ci.nsIRDFRemoteDataSource);
        if (remote)
            remote.Flush();
    }
}

// Helper function for writing to the RDF data source.
function updateAttribute(aProperty, aOldValue, aNewValue) {
    var resource = RDF.GetResource(gFeed.bookmarkID);

    if ((aOldValue || aNewValue) && aOldValue != aNewValue) {
        if (aOldValue && !aNewValue)
            BMDS.Unassert(gResource, aProperty, aOldValue);
        else if (!aOldValue && aNewValue)
            BMDS.Assert(resource, aProperty, aNewValue, true);
        else
            BMDS.Change(resource, aProperty, aOldValue, aNewValue);

        return true;
    }

    return false;
}