const Cc = Components.classes;
const Ci = Components.interfaces;

var gCustomStyleFile = null;
var gTextbox = null;

function init() {
    sizeToContent();

    var chromeDir = Cc['@mozilla.org/file/directory_service;1'].
                    getService(Ci.nsIProperties).
                    get('ProfD', Ci.nsIFile);
    chromeDir.append('chrome');

    gCustomStyleFile = chromeDir.clone();
    gCustomStyleFile.append('brief-custom-style.css');

    // If the custom CSS file doesn't exist, create it by copying the example file.
    if (!gCustomStyleFile.exists()) {
        var exampleCustomStyle = Cc['@mozilla.org/extensions/manager;1'].
                                 getService(Ci.nsIExtensionManager).
                                 getInstallLocation('brief@mozdev.org').
                                 getItemLocation('brief@mozdev.org');
        exampleCustomStyle.append('defaults');
        exampleCustomStyle.append('data');
        exampleCustomStyle.append('example-custom-style.css');
        exampleCustomStyle.copyTo(chromeDir, 'brief-custom-style.css');
    }

    var uri = Cc['@mozilla.org/network/protocol;1?name=file'].
              getService(Ci.nsIFileProtocolHandler).
              newFileURI(gCustomStyleFile);

    var request = new XMLHttpRequest();
    request.open('GET', uri.spec, false);
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
