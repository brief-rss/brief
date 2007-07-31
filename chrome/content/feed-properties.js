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
    checkUpdatesTextbox.disabled = !checkUpdatesCheckbox.checked;
    checkUpdatesTextbox.value = checkUpdatesTextbox.disabled ? '' : gFeed.updateInterval;
}

function onExpirationCheckboxCmd(aEvent) {
    var expirationTextbox = document.getElementById('expiration-textbox');
    expirationTextbox.disabled = !aEvent.target.checked;
}

function onMaxEntriesCheckboxCmd(aEvent) {
    var maxEntriesTextbox = document.getElementById('max-entries-textbox');
    maxEntriesTextbox.disabled = !aEvent.target.checked;
}

function onCheckUpdatesCheckboxCmd(aEvent) {
    var checkUpdatesTextbox = document.getElementById('check-updates-textbox');
    checkUpdatesTextbox.disabled = !aEvent.target.checked;
}


function OK() {
    var expirationCheckbox = document.getElementById('expiration-checkbox');
    var expirationTextbox = document.getElementById('expiration-textbox');
    var maxEntriesCheckbox = document.getElementById('max-entries-checkbox');
    var maxEntriesTextbox = document.getElementById('max-entries-textbox');
    var checkUpdatesCheckbox = document.getElementById('check-updates-checkbox');
    var checkUpdatesTextbox = document.getElementById('check-updates-textbox');

    if (expirationCheckbox.checked && expirationTextbox.value)
        gFeed.entryAgeLimit = expirationTextbox.value;
    else
        gFeed.entryAgeLimit = 0;

    if (maxEntriesCheckbox.checked && maxEntriesTextbox.value)
        gFeed.maxEntries = maxEntriesTextbox.value;
    else
        gFeed.maxEntries = 0;

    if (checkUpdatesCheckbox.checked && checkUpdatesTextbox.value)
        gFeed.updateInterval = checkUpdatesTextbox.value;
    else
        gFeed.updateInterval = 0;

    gStorageService.setFeedOptions(gFeed);

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

    return true;
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