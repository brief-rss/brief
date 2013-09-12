Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/FileUtils.jsm');

IMPORT_COMMON(this);

function BriefService() {
    // Initialize Storage module.
    Components.utils.import('resource://brief/Storage.jsm');

    // Register the custom CSS file under a resource URI.
    let resourceProtocolHandler = Services.io.getProtocolHandler('resource')
                                             .QueryInterface(Ci.nsIResProtocolHandler);
    let file = FileUtils.getFile('ProfD', ['chrome', 'brief-custom-style.css']);
    let uri = Services.io.newFileURI(file);
    resourceProtocolHandler.setSubstitution('brief-custom-style.css', uri);
}

BriefService.prototype = {

    // mozIStorageVacuumParticipant
    get databaseConnection() {
        return Components.utils.getGlobalForObject(Storage).Connection._nativeConnection;
    },

    // mozIStorageVacuumParticipant
    expectedDatabasePageSize: Ci.mozIStorageConnection.DEFAULT_PAGE_SIZE,

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
    observe: function() {

    },

    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                           Ci.mozIStorageVacuumParticipant])

}

let NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefService]);
