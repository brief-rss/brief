const Cc = Components.classes;
const Ci = Components.interfaces;

function init() {
    sizeToContent();
    setTimeout(gMainPane.setUpFoldersTree, 0);

    gFeedsPane.updateIntervalDisabledState();
    gFeedsPane.updateExpirationDisabledState();
    gFeedsPane.updateStoredEntriesDisabledState();
    gDisplayPane.updateCustomStyleDisabledState();
}

var gMainPane = {

    setUpFoldersTree: function() {
        var folderID = Cc['@mozilla.org/preferences-service;1'].
                       getService(Ci.nsIPrefBranch).
                       getCharPref('extensions.brief.liveBookmarksFolder');
        if (folderID) {
            var rdfService = Cc['@mozilla.org/rdf/rdf-service;1'].
                             getService(Ci.nsIRDFService);
            var folder = rdfService.GetResource(folderID);

            var foldersTree = document.getElementById('folders-tree');
            foldersTree.treeBoxObject.view.selection.selectEventsSuppressed = true;
            foldersTree.treeBoxObject.view.selection.clearSelection();
            foldersTree.selectResource(folder);
            var index = foldersTree.currentIndex;
            foldersTree.treeBoxObject.ensureRowIsVisible(index);
            foldersTree.treeBoxObject.view.selection.selectEventsSuppressed = false;
        }
    },

    onFolderSelected: function(aEvent) {
        var foldersTree = document.getElementById('folders-tree');
        var selectedIndex = foldersTree.currentIndex;
        if (selectedIndex != -1) {
            var resource = foldersTree.treeBuilder.getResourceAtIndex(selectedIndex);

            var pref = document.getElementById('extensions.brief.liveBookmarksFolder');
            pref.value = resource.Value;
        }
    }

}


var gFeedsPane = {

    updateIntervalDisabledState: function() {
        var textbox = document.getElementById("updateInterval");
        var checkbox = document.getElementById("checkForUpdates");

        textbox.disabled = !checkbox.checked;
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

        var stringbundle = document.getElementById('main-bundle');
        var title = stringbundle.getString('confirmClearAllEntriesTitle');
        var text = stringbundle.getString('confirmClearAllEntriesText');
        var checkboxLabel = stringbundle.getString('confirmClearAllEntriesCheckbox');
        var checked = { value: keepStarred };

        var result = promptService.confirmCheck(window, title, text, checkboxLabel, checked);
        if (result) {
            var query = Cc['@ancestor/brief/query;1'].createInstance(Ci.nsIBriefQuery);
            query.deleted = Ci.nsIBriefQuery.ENTRY_STATE_ANY;
            query.unstarred = checked.value;
            query.includeHiddenFeeds = true;

            var storageService = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
            storageService.deleteEntries(Ci.nsIBriefStorage.ENTRY_STATE_DELETED, query);

            prefBranch.setBoolPref('extensions.brief.database.keepStarredWhenClearing', checked.value)
        }
    }

}


var gDisplayPane = {

    updateCustomStyleDisabledState: function() {
        var pathTextbox = document.getElementById('custom-style-path');
        var browseButton = document.getElementById('browse-custom-style');
        var enableCustomStyle = document.getElementById('custom-style-checkbox');

        pathTextbox.disabled = !enableCustomStyle.checked;
        browseButton.disabled = !enableCustomStyle.checked;
    },

    browseCustomStyle: function() {
        var picker = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
        var stringbundle = document.getElementById('main-bundle');
        var pickerTitle = stringbundle.getString('stylePickerTitle');
        var pickerFilterName = stringbundle.getString('stylePickerExtFilterName');
        picker.init(window, pickerTitle, picker.modeOpen);
        picker.appendFilter(pickerFilterName, '*.css');
        picker.appendFilters(picker.filterAll);

        var result = picker.show();
        if (result == picker.returnOK) {
            var pathTextbox = document.getElementById('custom-style-path');
            pathTextbox.value = picker.file.path;
            var pref = document.getElementById('extensions.brief.feedview.customStylePath');
            pref.value = pathTextbox.value;
        }
    }

}