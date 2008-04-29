const Cc = Components.classes;
const Ci = Components.interfaces;
const EXT_ID = 'brief@mozdev.org';

var gCustomStyleFile = null;
var gTextbox = null;

function init() {
    sizeToContent();

    gCustomStyleFile = Cc['@mozilla.org/extensions/manager;1'].
                       getService(Ci.nsIExtensionManager).
                       getInstallLocation(EXT_ID).
                       getItemLocation(EXT_ID);
    gCustomStyleFile.append('defaults');
    gCustomStyleFile.append('data');
    gCustomStyleFile.append('custom-style.css');

    var request = new XMLHttpRequest();
    request.open('GET', 'file:///' + gCustomStyleFile.path, false);
    request.overrideMimeType('text/css');
    request.send(null);

    gTextbox = document.getElementById('custom-style-textbox');
    gTextbox.value = request.responseText;
}


function onAccept() {
    var stream = Cc['@mozilla.org/network/file-output-stream;1'].
                 createInstance(Ci.nsIFileOutputStream);
    stream.init(gCustomStyleFile, 0x02 | 0x08 | 0x20, -1, 0); // write, create, truncate
    stream.write(gTextbox.value, gTextbox.value.length);
    stream.close();

    var observerService = Cc['@mozilla.org/observer-service;1'].
                          getService(Ci.nsIObserverService);
    observerService.notifyObservers(null, 'brief:custom-style-changed', '');
}
