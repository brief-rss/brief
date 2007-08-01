const NC_NAME          = 'http://home.netscape.com/NC-rdf#Name';
const NC_FEEDURL       = 'http://home.netscape.com/NC-rdf#FeedURL';

var gFeed;
var gStorageService = Components.classes['@ancestor/brief/storage;1'].
                                 getService(Components.interfaces.nsIBriefStorage);

function onload() {
    var nameTextbox = document.getElementById('feed-name-textbox');
    var urlTextbox = document.getElementById('feed-url-textbox');
    var expirationCheckbox = document.getElementById('expiration-checkbox');
    var expirationTextbox = document.getElementById('expiration-textbox');
    var maxEntriesCheckbox = document.getElementById('max-entries-checkbox');
    var maxEntriesTextbox = document.getElementById('max-entries-textbox');
    var checkUpdatesCheckbox = document.getElementById('check-updates-checkbox');
    var checkUpdatesTextbox = document.getElementById('check-updates-textbox');
    var checkUpdatesMenulist = document.getElementById('update-time-menulist');

    var feedID = window.arguments[0];
    gFeed = gStorageService.getFeed(feedID);

    var stringbundle = document.getElementById('main-bundle');
    var string = stringbundle.getFormattedString('feedPropertiesDialogTitle', [gFeed.title]);
    document.title = string;

    nameTextbox.value = gFeed.title;
    urlTextbox.value = gFeed.feedURL;

    expirationCheckbox.checked = (gFeed.entryAgeLimit > 0);
    expirationTextbox.disabled = !expirationCheckbox.checked;
    expirationTextbox.value = expirationTextbox.disabled ? '' : gFeed.entryAgeLimit;

    maxEntriesCheckbox.checked = (gFeed.maxEntries > 0);
    maxEntriesTextbox.disabled = !maxEntriesCheckbox.checked;
    maxEntriesTextbox.value = maxEntriesTextbox.disabled ? '' : gFeed.maxEntries;

    checkUpdatesCheckbox.checked = (gFeed.updateInterval > 0);
    checkUpdatesTextbox.disabled = checkUpdatesMenulist.disabled = !checkUpdatesCheckbox.checked;
    checkUpdatesTextbox.value = checkUpdatesTextbox.disabled ? '' : gFeed.updateInterval;

    initUpdateIntervalControls();
}

function initUpdateIntervalControls() {
    var interval = gFeed.updateInterval;
    if (interval == 0)
        return;

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


function OK() {
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
        var intervalInSeconds;

        switch (checkUpdatesMenulist.selectedIndex) {
            case 0:
                intervalInSeconds = textboxValue * 60; // textbox.value is in minutes
                break;
            case 1:
                intervalInSeconds = textboxValue * 60*60; // textbox.value is in hours
                break;
            case 2:
                intervalInSeconds = textboxValue * 60*60*24; // textbox.value is in days
                break;
        }

        gFeed.updateInterval = intervalInSeconds;
    }
    else
        gFeed.updateInterval = 0;

    gStorageService.setFeedOptions(gFeed);

    saveLiveBookmarksData();

    return true;
}

function saveLiveBookmarksData() {
    // We need to write values of properties that come from Live Bookmarks.
    // First, init stuff.
    var changed = false;
    initServices();
    initBMService();
    var resource = RDF.GetResource(gFeed.rdf_uri);
    var field, arc, newValue, oldValue;

    // Write the name.
    field = document.getElementById('feed-name-textbox');
    newValue = field.value;
    arc = RDF.GetResource(NC_NAME)
    oldValue = BMDS.GetTarget(resource, arc, true);
    if (oldValue)
        oldValue = oldValue.QueryInterface(Components.interfaces.nsIRDFLiteral);
    if (newValue)
        newValue = RDF.GetLiteral(newValue);
    changed |= updateAttribute(arc, oldValue, newValue);


    // Write the URL.
    field = document.getElementById('feed-url-textbox')
    newValue = field.value;
    arc = RDF.GetResource(NC_FEEDURL);
    oldValue = BMDS.GetTarget(resource, arc, true);
    if (oldValue)
        oldValue = oldValue.QueryInterface(Components.interfaces.nsIRDFLiteral);
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
        var remote = BMDS.QueryInterface(Components.interfaces.nsIRDFRemoteDataSource);
        if (remote)
            remote.Flush();
    }
}

// Helper function for writing to the RDF data source.
function updateAttribute(aProperty, aOldValue, aNewValue) {
    var resource = RDF.GetResource(gFeed.rdf_uri);

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