const Cc = Components.classes;
const Ci = Components.interfaces;

function init() {
  gMainPane.setUpUpdateCheckUI();
  setTimeout(gMainPane.setUpFoldersTree, 0);
  
  gDisplayPane.updateCustomStyleDisabledState();
};

var gMainPane = { 

  setUpUpdateCheckUI: function() {
    var pref = document.getElementById("extensions.brief.update.interval");
    var mirror = document.getElementById("extensions.brief.update.interval_mirror");
    var textbox = document.getElementById("updateInterval");
    var checkbox = document.getElementById("checkForUpdates");

    // handle mirror non-existence or mirror/pref unsync
    if (mirror.value === null)
      mirror.value = pref.value ? pref.value : pref.defaultValue;
    checkbox.checked = (pref.value > 0);
    textbox.disabled = !(pref.value > 0);

    // hook up textbox to mirror preference and force a preference read
    textbox.setAttribute("onsynctopreference", 
                         "return gMainPane._writeUpdateIntervalMirror();");
    textbox.setAttribute("preference", "extensions.brief.update.interval_mirror");
    mirror.updateElements();
  },  
  
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
  },
  

  _writeUpdateIntervalMirror: function() {
    var pref = document.getElementById("extensions.brief.update.interval");
    var textbox = document.getElementById("updateInterval");
    pref.value = textbox.value;
    // don't override the value in the textbox
    return undefined;
  },

  
  onChangeCheckForUpdates: function() {
    var pref = document.getElementById("extensions.brief.update.interval");
    var mirror = document.getElementById("extensions.brief.update.interval_mirror");
    var textbox = document.getElementById("updateInterval");
    var checkbox = document.getElementById("checkForUpdates");

    pref.value = checkbox.checked ? mirror.value : 0;
    textbox.disabled = !checkbox.checked;
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
      var pref = document.getElementById('extensions.brief.customStylePath');
      pref.value = pathTextbox.value;
    }
  }
  
}


function dump(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n ' + aMessage);
};
