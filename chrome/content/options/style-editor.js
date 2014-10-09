Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/osfile.jsm');

IMPORT_COMMON(this);

const EXAMPLE_CSS = '/* Example: change font size of item title */\n.title-link {\n    font-size: 15px;\n}';

let path = OS.Path.join(OS.Constants.Path.profileDir, 'chrome', 'brief-custom-style.css');
let textbox;


function init() {
    sizeToContent();

    textbox = document.getElementById('custom-style-textbox');

    OS.File.read(path).then(
        dataArray => textbox.value = new TextDecoder().decode(dataArray),
        error => textbox.value = EXAMPLE_CSS
    )
}


function onAccept() {
    let dataArray = new TextEncoder().encode(textbox.value);
    OS.File.writeAtomic(path, dataArray).then(
        () => Services.obs.notifyObservers(null, 'brief:custom-style-changed', '')
    )
}
