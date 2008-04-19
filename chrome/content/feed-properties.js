var Ci = Components.interfaces;
var Cc = Components.classes;

var gFeed = null;
var gStorage = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
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
        gFeed = gStorage.getFeed(feedID);
    }

    var stringbundle = document.getElementById('options-bundle');
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

    var index = getFeedIndex(gFeed);

    var nextFeed = document.getElementById('next-feed');
    var previousFeed = document.getElementById('previous-feed');
    nextFeed.disabled = (index == gStorage.getAllFeeds().length - 1);
    previousFeed.disabled = (index == 0);
}

function showFeed(aDeltaIndex) {
    saveChanges();
    gFeed = gStorage.getAllFeeds()[getFeedIndex(gFeed) + aDeltaIndex];
    setupWindow();
}

function getFeedIndex(aFeed) {
    var index = -1;
    var allFeeds = gStorage.getAllFeeds();
    for (let i = 0; index < allFeeds.length; i++) {
        if (allFeeds[i].feedID == aFeed.feedID) {
            index = i;
            break;
        }
    }
    return index;
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
    else {
        gFeed.updateInterval = 0;
    }

    gStorage.setFeedOptions(gFeed);

    saveLivemarksData();

    return true;
}

function saveLivemarksData() {
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
