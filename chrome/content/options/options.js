var Ci = Components.interfaces;
var Cc = Components.classes;

function init() {
    gMainPane.setUpPlacesTree();

    sizeToContent();

    gFeedsPane.initUpdateIntervalControls();
    gFeedsPane.updateExpirationDisabledState();
    gFeedsPane.updateStoredEntriesDisabledState();

    opml.init();
}

function unload() {
    gFeedsPane.saveUpdateIntervalPref();
}


var gMainPane = {

    setUpPlacesTree: function() {
        var tree = document.getElementById('places-tree');
        var pref = document.getElementById('extensions.brief.homeFolder');

        // Populate the tree.
        var query = PlacesUtils.history.getNewQuery();
        var options = PlacesUtils.history.getNewQueryOptions();
        query.setFolders([PlacesUIUtils.allBookmarksFolderId], 1);
        options.excludeItems = true;
        tree.load([query], options);

        tree.selectItems([pref.value]);
    },

    onPlacesTreeSelect: function(aEvent) {
        var placesTree = document.getElementById('places-tree');
        var pref = document.getElementById('extensions.brief.homeFolder');

        if (placesTree.currentIndex != -1)
            pref.value = PlacesUtils.getConcreteItemId(placesTree.selectedNode);
    }

}


var gFeedsPane = {

    updateIntervalDisabledState: function() {
        var textbox = document.getElementById('updateInterval');
        var checkbox = document.getElementById('checkForUpdates');
        var menulist = document.getElementById('update-time-menulist');

        textbox.disabled = menulist.disabled = !checkbox.checked;
    },

    initUpdateIntervalControls: function() {
        var pref = document.getElementById('extensions.brief.update.interval').value;
        var menulist = document.getElementById('update-time-menulist');
        var textbox = document.getElementById('updateInterval');

        var toDays = pref / (60*60*24);
        var toHours = pref / (60*60);
        var toMinutes = pref / 60;

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
    },

    saveUpdateIntervalPref: function() {
        var pref = document.getElementById('extensions.brief.update.interval');
        var textbox = document.getElementById('updateInterval');
        var menulist = document.getElementById('update-time-menulist');

        var intervalInSeconds;
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
    },

    updateExpirationDisabledState: function() {
        var textbox = document.getElementById('expiration-textbox');
        var checkbox = document.getElementById('expiration-checkbox');

        textbox.disabled = !checkbox.checked;
    },

    updateStoredEntriesDisabledState: function() {
        var textbox = document.getElementById('stored-entries-textbox');
        var checkbox = document.getElementById('stored-entries-checkbox');

        textbox.disabled = !checkbox.checked;
    },

    onClearAllEntriesCmd: function(aEvent) {
        var promptService = Cc['@mozilla.org/embedcomp/prompt-service;1'].
                            getService(Ci.nsIPromptService);
        var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                         getService(Ci.nsIPrefBranch);
        var keepStarred = prefBranch.getBoolPref('extensions.brief.database.keepStarredWhenClearing');

        var stringbundle = document.getElementById('options-bundle');
        var title = stringbundle.getString('confirmClearAllEntriesTitle');
        var text = stringbundle.getString('confirmClearAllEntriesText');
        var checkboxLabel = stringbundle.getString('confirmClearAllEntriesCheckbox');
        var checked = { value: keepStarred };

        var result = promptService.confirmCheck(window, title, text, checkboxLabel, checked);
        if (result) {
            var query = Cc['@ancestor/brief/query;1'].createInstance(Ci.nsIBriefQuery);
            query.unstarred = checked.value;
            query.includeHiddenFeeds = true;
            query.deleteEntries(Ci.nsIBriefQuery.ENTRY_STATE_DELETED);

            prefBranch.setBoolPref('extensions.brief.database.keepStarredWhenClearing', checked.value)
        }
    }

}


var gDisplayPane = {

    editCustomStyle: function() {
        window.openDialog('chrome://brief/content/options/style-editor.xul',
                          'Style editor', 'chrome,centerscreen,titlebar,resizable');
    },

    showShortcuts: function() {
        var screenHeight = window.screen.availHeight;
        var height = screenHeight < 620 ? screenHeight : 620;
        var features = 'chrome,centerscreen,titlebar,resizable,width=500,height=' + height;
        var url = 'chrome://brief/content/keyboard-shortcuts.xhtml';

        window.openDialog(url, 'Brief shortcuts', features);
    }

}

function dump(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage(aMessage);
}