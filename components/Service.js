Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/FileUtils.jsm');

IMPORT_COMMON(this);

// Test using: Cc["@mozilla.org/storage/vacuum;1"].getService(Ci.nsIObserver)
//     .observe(null, "idle-daily", null);
function BriefService() {
    // Initialize modules.
    Components.utils.import('resource://brief/Storage.jsm');
    let storagePromise = Storage.init();
    Components.utils.import('resource://brief/FeedUpdateService.jsm');
    FeedUpdateService.init();

    // Register the custom CSS file under a resource URI.
    let resourceProtocolHandler = Services.io.getProtocolHandler('resource')
                                             .QueryInterface(Ci.nsIResProtocolHandler);
    let file = FileUtils.getFile('ProfD', ['chrome', 'brief-custom-style.css']);
    let uri = Services.io.newFileURI(file);
    resourceProtocolHandler.setSubstitution('brief-custom-style.css', uri);

    this._dbConn = null;
    storagePromise.then(() => {
        this._dbConn = Storage.createRawDatabaseConnection();
        Services.obs.addObserver(this, 'quit-application', false);
    }).catch(Components.utils.reportError);
}

BriefService.prototype = {
    // mozIStorageVacuumParticipant
    get databaseConnection() {
        return this._dbConn;
    },

    // mozIStorageVacuumParticipant
    get expectedDatabasePageSize() {
        return this._dbConn.defaultPageSize;
    },

    // mozIStorageVacuumParticipant
    onBeginVacuum: function onBeginVacuum() {
        Components.utils.import('resource://brief/FeedUpdateService.jsm');
        FeedUpdateService.stopUpdating();

        return true;
    },

    // mozIStorageVacuumParticipant
    onEndVacuum: function onEndVacuum(aSucceeded) {

    },

    // nsIObserver
    observe: function observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'quit-application':
                Services.obs.removeObserver(this, 'quit-application');
                this._dbConn.close();
                break;
        }
    },

    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                           Ci.mozIStorageVacuumParticipant])

}

let NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefService]);
