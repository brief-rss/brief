Components.utils.import('resource://digest/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/AddonManager.jsm');

IMPORT_COMMON(this);


let gCustomStyleFile = null;
let gTextbox = null;

function init() {
    sizeToContent();

    gTextbox = document.getElementById('custom-style-textbox');

    let chromeDir = Services.dirsvc.get('ProfD', Ci.nsIFile);
    chromeDir.append('chrome');

    gCustomStyleFile = chromeDir.clone();
    gCustomStyleFile.append('brief-custom-style.css');

    if (!gCustomStyleFile.exists()) {
        gCustomStyleFile.create(Ci.nsIFile.NORMAL_FILE_TYPE, parseInt("0644", 8));

        AddonManager.getAddonByID('digest@tanriol.github.io', function(addon) {
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


function populateTextbox() {
    let uri = Cc['@mozilla.org/network/protocol;1?name=file']
              .getService(Ci.nsIFileProtocolHandler)
              .newFileURI(gCustomStyleFile);
    gTextbox.value = fetchCSSText(uri);
}


function fetchCSSText(aURI) {
    let request = new XMLHttpRequest();
    request.open('GET', aURI.spec, false);
    request.overrideMimeType('text/css');
    request.send(null);

    return request.responseText;
}


function writeCustomCSSFile(aData) {
    let stream = Cc['@mozilla.org/network/file-output-stream;1']
                 .createInstance(Ci.nsIFileOutputStream);
    stream.init(gCustomStyleFile, 0x02 | 0x08 | 0x20, -1, 0); // write, create, truncate
    stream.write(aData, aData.length);
    stream.close();
}


function onAccept() {
    writeCustomCSSFile(gTextbox.value, gTextbox.value.length);
    Services.obs.notifyObservers(null, 'brief:custom-style-changed', '');
}
