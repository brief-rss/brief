Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/StyleFile.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/osfile.jsm');

let textbox;

function init() {
    sizeToContent();

    textbox = document.getElementById('custom-style-textbox');
    textbox.value = StyleFile.text.get();
}

function onAccept() {
    StyleFile.update(textbox.value);
}
