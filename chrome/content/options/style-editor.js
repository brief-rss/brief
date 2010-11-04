const Cc = Components.classes;
const Ci = Components.interfaces;

Components.utils.import('resource://gre/modules/AddonManager.jsm');

var gCustomStyleFile = null;
var gTextbox = null;

function init() {
    sizeToContent();

    gTextbox = document.getElementById('custom-style-textbox');

    var chromeDir = Cc['@mozilla.org/file/directory_service;1'].
                    getService(Ci.nsIProperties).
                    get('ProfD', Ci.nsIFile);
    chromeDir.append('chrome');

    gCustomStyleFile = chromeDir.clone();
    gCustomStyleFile.append('brief-custom-style.css');

    if ('@mozilla.org/extensions/manager;1' in Cc) {
        // If the custom CSS file doesn't exist, create it by copying the example file.
        if (!gCustomStyleFile.exists()) {
            let exampleCustomStyle = Cc['@mozilla.org/extensions/manager;1']
                                     .getService(Ci.nsIExtensionManager)
                                     .getInstallLocation('brief@mozdev.org')
                                     .getItemLocation('brief@mozdev.org');
            exampleCustomStyle.append('defaults');
            exampleCustomStyle.append('data');
            exampleCustomStyle.append('example-custom-style.css');
            exampleCustomStyle.copyTo(chromeDir, 'brief-custom-style.css');
        }

        populateTextbox();
    }
    else {
        if (!gCustomStyleFile.exists()) {
            gCustomStyleFile.create(Ci.nsIFile.NORMAL_FILE_TYPE, 777);

            AddonManager.getAddonByID('brief@mozdev.org', function(addon) {
                let uri = addon.getResourceURI('/defaults/data/example-custom-style.css');
                let cssText = fetchCSSText(uri);
                writeCustomCSSFile(cssText);
                gTextbox.value = cssText;
            })
        }
        else {
            populateTextbox();
        }
    }
}


function populateTextbox() {
    let uri = Cc['@mozilla.org/network/protocol;1?name=file']
              .getService(Ci.nsIFileProtocolHandler)
              .newFileURI(gCustomStyleFile);
    gTextbox.value = fetchCSSText(uri);
}


function fetchCSSText(aURI) {
    var request = new XMLHttpRequest();
    request.open('GET', aURI.spec, false);
    request.overrideMimeType('text/css');
    request.send(null);

    return request.responseText;
}


function writeCustomCSSFile(aData) {
    var stream = Cc['@mozilla.org/network/file-output-stream;1']
                 .createInstance(Ci.nsIFileOutputStream);
    stream.init(gCustomStyleFile, 0x02 | 0x08 | 0x20, -1, 0); // write, create, truncate
    stream.write(aData, aData.length);
    stream.close();
}


function onAccept() {
    writeCustomCSSFile(gTextbox.value, gTextbox.value.length);

    var observerService = Cc['@mozilla.org/observer-service;1'].
                          getService(Ci.nsIObserverService);
    observerService.notifyObservers(null, 'brief:custom-style-changed', '');
}
