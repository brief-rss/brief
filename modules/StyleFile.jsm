'use strict';

const EXPORTED_SYMBOLS = ['StyleFile'];

Components.utils.import('resource://brief/common.jsm');

Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/osfile.jsm');

const EXAMPLE_CSS = '/* Example: change font size of item title */\n.title-link {\n    font-size: 15px;\n}';

let StyleFile = {
    path: OS.Path.join(OS.Constants.Path.profileDir, 'chrome', 'brief-custom-style.css'),
    text: null,

    // Load the custom style
    async init() {
        let text = await OS.File.read(this.path).then(
            dataArray => new TextDecoder().decode(dataArray),
            error => EXAMPLE_CSS
        );
        this.text = new DataSource(text);
    },

    // Save the updated style and notify tabs to update it
    async update(text) {
        this.text.set(text);
        let dataArray = new TextEncoder().encode(text);
        await OS.File.writeAtomic(this.path, dataArray);
        Services.obs.notifyObservers(null, 'brief:custom-style-changed', '');
    },
};





