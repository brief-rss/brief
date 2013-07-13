Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Storage.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/PlacesUtils.jsm');

IMPORT_COMMON(this);

let gFeed = null;
let Prefs = Services.prefs.getBranch('extensions.brief.');

function getElement(aId) document.getElementById(aId);


function setupWindow() {
    if (!gFeed)
        gFeed = Storage.getFeed(window.arguments[0]);

    let bundle = getElement('options-bundle');
    document.title = bundle.getFormattedString('feedPropertiesDialogTitle', [gFeed.title]);

    getElement('feed-name-textbox').value = gFeed.title;
    getElement('feed-url-textbox').value = gFeed.feedURL;

    initUpdateIntervalControls();

    let expirationCheckbox = getElement('expiration-checkbox');
    let expirationTextbox = getElement('expiration-textbox');
    expirationCheckbox.checked = (gFeed.entryAgeLimit > 0);
    expirationTextbox.disabled = !expirationCheckbox.checked;
    expirationTextbox.value = gFeed.entryAgeLimit || Prefs.getIntPref('database.entryExpirationAge');

    getElement('updated-entries-checkbox').checked = !gFeed.markModifiedEntriesUnread;
    getElement('omit-in-unread-checkbox').checked = gFeed.omitInUnread;

    let index = getFeedIndex(gFeed);
    getElement('next-feed').disabled = (index == Storage.getAllFeeds().length - 1);
    getElement('previous-feed').disabled = (index == 0);
}

function showFeed(aDeltaIndex) {
    saveChanges();
    gFeed = Storage.getAllFeeds()[getFeedIndex(gFeed) + aDeltaIndex];
    setupWindow();
}

function getFeedIndex(aFeed) {
    let index = -1;
    let allFeeds = Storage.getAllFeeds();
    for (let i = 0; index < allFeeds.length; i++) {
        if (allFeeds[i].feedID == aFeed.feedID) {
            index = i;
            break;
        }
    }
    return index;
}

function initUpdateIntervalControls() {
    let checkbox = getElement('check-updates-checkbox');
    let textbox = getElement('check-updates-textbox');
    let menulist = getElement('update-time-menulist');

    checkbox.checked = (gFeed.updateInterval > 0);
    textbox.disabled = menulist.disabled = !checkbox.checked;

    let interval = gFeed.updateInterval / 1000 || Prefs.getIntPref('update.interval');
    let toDays = interval / (60 * 60 * 24);
    let toHours = interval / (60 * 60);
    let toMinutes = interval / 60;

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
    let textbox = getElement('check-updates-textbox');
    let menulist = getElement('update-time-menulist');
    textbox.disabled = menulist.disabled = !aEvent.target.checked;
}


function saveChanges() {
    saveLivemarksData();

    let properties = {
        feedID: gFeed.feedID,
        omitInUnread: getElement('omit-in-unread-checkbox').checked ? 1 : 0,
        markModifiedEntriesUnread: !getElement('updated-entries-checkbox').checked
    }

    let expirationCheckbox = getElement('expiration-checkbox');
    let expirationTextbox = getElement('expiration-textbox');
    properties.entryAgeLimit = expirationCheckbox.checked && expirationTextbox.value
                               ? expirationTextbox.value
                               : 0;

    let checkUpdatesTextbox = getElement('check-updates-textbox');
    let checkUpdatesMenulist = getElement('update-time-menulist');
    let checkUpdatesCheckbox = getElement('check-updates-checkbox');

    if (checkUpdatesCheckbox.checked && checkUpdatesTextbox.value) {
        let textboxValue = checkUpdatesTextbox.value;
        let intervalInMilliseconds;

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

        properties.updateInterval = intervalInMilliseconds;
    }
    else {
        properties.updateInterval = 0;
    }

    Storage.changeFeedProperties(properties);

    return true;
}

function saveLivemarksData() {
    let nameTextbox = getElement('feed-name-textbox');
    let urlTextbox = getElement('feed-url-textbox');

    if (gFeed.title != nameTextbox.value)
        PlacesUtils.bookmarks.setItemTitle(gFeed.bookmarkID, nameTextbox.value);

    if (gFeed.feedURL != urlTextbox.value) {
        let uri = Services.io.newURI(urlTextbox.value, null, null);
        PlacesUtils.livemarks.setFeedURI(gFeed.bookmarkID, uri);
    }
}
