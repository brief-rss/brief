Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Prefs.jsm');
Components.utils.import('resource://brief/API.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/FileUtils.jsm');

IMPORT_COMMON(this);

function BriefService() {
    PrefLoader.setDefaultPrefs(); // No clear needed, shutdown is enough
    // Initialize modules.
    Components.utils.import('resource://brief/Storage.jsm');
    Storage.init();
    Components.utils.import('resource://brief/FeedUpdateService.jsm');
    FeedUpdateService.init();
    // Initialize the client API
    this.API = new BriefServer();

    // Register the custom CSS file under a resource URI.
    let resourceProtocolHandler = Services.io.getProtocolHandler('resource')
                                             .QueryInterface(Ci.nsIResProtocolHandler);
    let file = FileUtils.getFile('ProfD', ['chrome', 'brief-custom-style.css']);
    let uri = Services.io.newFileURI(file);
    resourceProtocolHandler.setSubstitution('brief-custom-style.css', uri);
}

BriefService.prototype = {
    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    QueryInterface: XPCOMUtils.generateQI([])

}

let NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefService]);
