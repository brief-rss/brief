Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

IMPORT_COMMON(this);

function BriefService() {
    // Initialize Storage module.
    Components.utils.import('resource://brief/Storage.jsm');

    // Registers %profile%/chrome directory under a resource URI.
    let resourceProtocolHandler = Services.io.getProtocolHandler('resource')
                                             .QueryInterface(Ci.nsIResProtocolHandler);
    if (!resourceProtocolHandler.hasSubstitution('profile-chrome-dir')) {
        let chromeDir = Services.dirsvc.get('ProfD', Ci.nsIFile);
        chromeDir.append('chrome');
        let chromeDirURI = Services.io.newFileURI(chromeDir);
        resourceProtocolHandler.setSubstitution('profile-chrome-dir', chromeDirURI);
    }
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

        Components.utils.getGlobalForObject(Storage).StorageInternal.purgeEntries(false);
        
        return true;
    },

    // mozIStorageVacuumParticipant
    onEndVacuum: function onEndVacuum(aSucceeded) {

    },

    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.mozIStorageVacuumParticipant])

}

let NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefService]);
