Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/AddonManager.jsm');
Components.utils.import('resource://gre/modules/FileUtils.jsm');
Components.utils.import('resource://gre/modules/NetUtil.jsm');

IMPORT_COMMON(this);

const EXAMPLE_CSS = '/* Example: change font size of item title */\n.title-link {\n    font-size: 15px;\n}';

let file;
let textbox;

function init() {
    sizeToContent();

    textbox = document.getElementById('custom-style-textbox');
    file = FileUtils.getFile('ProfD', ['chrome', 'brief-custom-style.css']);

    if (file.exists()) {
        let request = new XMLHttpRequest();
        request.open('GET', NetUtil.newURI(file).spec);
        request.overrideMimeType('text/css');
        request.onload = function() textbox.value = request.responseText;
        request.send();
    }
    else {
        textbox.value = EXAMPLE_CSS;
    }
}


function onAccept() {
    let inputStream = Cc['@mozilla.org/io/string-input-stream;1']
                      .createInstance(Ci.nsIStringInputStream);
    // A little hack. An empty string wouldn't be written, making it impossible
    // to save an empty file.
    let string = textbox.value || ' ';
    inputStream.setData(string, string.length);

    let outputStream = FileUtils.openFileOutputStream(file);

    NetUtil.asyncCopy(inputStream, outputStream, result => {
        if (Components.isSuccessCode(result))
            Services.obs.notifyObservers(null, 'brief:custom-style-changed', '');
    })
}
