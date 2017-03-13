Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/FileUtils.jsm');

IMPORT_COMMON(this);

function BriefService() {
    // Initialize modules.
    Components.utils.import('resource://brief/Storage.jsm');
    Storage.init();
    Components.utils.import('resource://brief/FeedUpdateService.jsm');
    FeedUpdateService.init();

    // Register the custom CSS file under a resource URI.
    let resourceProtocolHandler = Services.io.getProtocolHandler('resource')
                                             .QueryInterface(Ci.nsIResProtocolHandler);
    let file = FileUtils.getFile('ProfD', ['chrome', 'brief-custom-style.css']);
    let uri = Services.io.newFileURI(file);
    resourceProtocolHandler.setSubstitution('brief-custom-style.css', uri);

    // Register API handlers
    this.handlers = new Map([
        ['brief:get-update-status', msg => FeedUpdateService.getStatus()],
        ['brief:update-feeds', msg => FeedUpdateService.updateFeeds(msg.data.feeds)],
        ['brief:update-all-feeds', msg => FeedUpdateService.updateAllFeeds()],
        ['brief:stop-updating', msg => FeedUpdateService.stopUpdating()],
    ]);
    for(let name of this.handlers.keys()) {
        Services.mm.addMessageListener(name, this, false);
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

        return true;
    },

    // mozIStorageVacuumParticipant
    onEndVacuum: function onEndVacuum(aSucceeded) {

    },

    // nsIObserver
    observe: function() {

    },

    receiveMessage: function BriefService_receiveMessage(message) {
        let {name, data} = message;
        let handler = this.handlers.get(name);
        if(handler === undefined) {
            log("BriefService: no handler for " + name);
            return;
        }
        return handler(message);
    },

    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                           Ci.mozIStorageVacuumParticipant])

}

let NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefService]);
