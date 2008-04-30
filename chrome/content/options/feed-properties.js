const Ci = Components.interfaces;
const Cc = Components.classes;

var gFeed = null;
var gStorage = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
var gPrefs = Cc['@mozilla.org/preferences-service;1'].getService(Ci.nsIPrefService).
                                                      getBranch('extensions.brief.');

function getElement(aId) document.getElementById(aId);


function setupWindow() {
    if (!gFeed)
        gFeed = gStorage.getFeed(window.arguments[0]);

    document.title = getElement('options-bundle').
                     getFormattedString('feedPropertiesDialogTitle', [gFeed.title]);

    getElement('feed-name-textbox').value = gFeed.title;
    getElement('feed-url-textbox').value = gFeed.feedURL;

    initUpdateIntervalControls();

    var expirationCheckbox = getElement('expiration-checkbox');
    var expirationTextbox = getElement('expiration-textbox');
    expirationCheckbox.checked = (gFeed.entryAgeLimit > 0);
    expirationTextbox.disabled = !expirationCheckbox.checked;
    expirationTextbox.value = gFeed.entryAgeLimit || gPrefs.getIntPref('database.entryExpirationAge');

    getElement('updated-entries-checkbox').checked = !gFeed.markModifiedEntriesUnread;

    var index = getFeedIndex(gFeed);
    getElement('next-feed').disabled = (index == gStorage.getAllFeeds().length - 1);
    getElement('previous-feed').disabled = (index == 0);
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
    var checkbox = getElement('check-updates-checkbox');
    var textbox = getElement('check-updates-textbox');
    var menulist = getElement('update-time-menulist');

    checkbox.checked = (gFeed.updateInterval > 0);
    textbox.disabled = menulist.disabled = !checkbox.checked;

    var interval = gFeed.updateInterval / 1000 || gPrefs.getIntPref('update.interval');
    var toDays = interval / (60 * 60 * 24);
    var toHours = interval / (60 * 60);
    var toMinutes = interval / 60;

    if (Math.ceil(toDays) == toDays) {
        // The pref value is in seconds. If it is dividable by days then use the
        // number of days as the textbox value and select Days in the menulist.
        menulist.selectedIndex = 2;
        textbox.value = toDays;
    }
    else if (Math.ceil(toHours) == toHours) {
        // Analogically for hours...
        menulist.selectedIndex = 1;
        textbox.value = toHours;
    }
    else {
        // Otherwise use minutes, ceiling to the nearest integer if necessary.
        menulist.selectedIndex = 0;
        textbox.value = Math.ceil(toMinutes);
    }
}

function onExpirationCheckboxCmd(aEvent) {
    getElement('expiration-textbox').disabled = !aEvent.target.checked;
}

function onCheckUpdatesCheckboxCmd(aEvent) {
    var textbox = getElement('check-updates-textbox');
    var menulist = getElement('update-time-menulist');
    textbox.disabled = menulist.disabled = !aEvent.target.checked;
}


function saveChanges() {
    var expirationCheckbox = getElement('expiration-checkbox');
    var expirationTextbox = getElement('expiration-textbox');

    if (expirationCheckbox.checked && expirationTextbox.value)
        gFeed.entryAgeLimit = expirationTextbox.value;
    else
        gFeed.entryAgeLimit = 0;

    var checkUpdatesTextbox = getElement('check-updates-textbox');
    var checkUpdatesMenulist = getElement('update-time-menulist');
    var checkUpdatesCheckbox = getElement('check-updates-checkbox');

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

    gFeed.markModifiedEntriesUnread = !getElement('updated-entries-checkbox').checked;

    gStorage.setFeedOptions(gFeed);

    saveLivemarksData();

    return true;
}

function saveLivemarksData() {
    var nameTextbox = getElement('feed-name-textbox');
    var urlTextbox = getElement('feed-url-textbox')

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
