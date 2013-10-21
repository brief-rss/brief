Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Storage.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');

IMPORT_COMMON(this);


function init() {
    window.sizeToContent();

    initUpdateIntervalControls();
    updateExpirationDisabledState();
    updateStoredEntriesDisabledState();
}

function unload() {
    saveUpdateIntervalPref();
}


function updateIntervalDisabledState() {
    let textbox = document.getElementById('updateInterval');
    let checkbox = document.getElementById('checkForUpdates');
    let menulist = document.getElementById('update-time-menulist');

    textbox.disabled = menulist.disabled = !checkbox.checked;
}

function initUpdateIntervalControls() {
    let pref = document.getElementById('extensions.brief.update.interval').value;
    let menulist = document.getElementById('update-time-menulist');
    let textbox = document.getElementById('updateInterval');

    let toDays = pref / (60*60*24);
    let toHours = pref / (60*60);
    let toMinutes = pref / 60;

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

    this.updateIntervalDisabledState();
}

function saveUpdateIntervalPref() {
    let pref = document.getElementById('extensions.brief.update.interval');
    let textbox = document.getElementById('updateInterval');
    let menulist = document.getElementById('update-time-menulist');

    let intervalInSeconds;
    switch (menulist.selectedIndex) {
        case 0:
            intervalInSeconds = textbox.value * 60; // textbox.value is in minutes
            break;
        case 1:
            intervalInSeconds = textbox.value * 60*60; // textbox.value is in hours
            break;
        case 2:
            intervalInSeconds = textbox.value * 60*60*24; // textbox.value is in days
            break;
    }

    pref.valueFromPreferences = intervalInSeconds;
}

function updateExpirationDisabledState() {
    let textbox = document.getElementById('expiration-textbox');
    let checkbox = document.getElementById('expiration-checkbox');

    textbox.disabled = !checkbox.checked;
}

function updateStoredEntriesDisabledState() {
    let textbox = document.getElementById('stored-entries-textbox');
    let checkbox = document.getElementById('stored-entries-checkbox');

    textbox.disabled = !checkbox.checked;
}

function onClearAllEntriesCmd(aEvent) {
    let keepStarred = Services.prefs.getBoolPref('extensions.brief.database.keepStarredWhenClearing');

    let stringbundle = document.getElementById('options-bundle');
    let title = stringbundle.getString('confirmClearAllEntriesTitle');
    let text = stringbundle.getString('confirmClearAllEntriesText');
    let checkboxLabel = stringbundle.getString('confirmClearAllEntriesCheckbox');
    let checked = { value: keepStarred };

    if (Services.prompt.confirmCheck(window, title, text, checkboxLabel, checked)) {
        let query = new Query({
            starred: checked.value ? false : undefined,
            includeHiddenFeeds: true
        });
        query.deleteEntries(Storage.ENTRY_STATE_DELETED);

        Services.prefs.setBoolPref('extensions.brief.database.keepStarredWhenClearing', checked.value)
    }
}

function editCustomStyle() {
    window.openDialog('chrome://brief/content/options/style-editor.xul',
                      'Style editor', 'chrome,centerscreen,titlebar,resizable');
}
