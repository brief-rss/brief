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
        ['brief:get-locale', msg => Cc['@mozilla.org/chrome/chrome-registry;1']
                .getService(Ci.nsIXULChromeRegistry).getSelectedLocale('brief')],

        ['brief:get-update-status', msg => FeedUpdateService.getStatus()],
        ['brief:update-feeds', msg => FeedUpdateService.updateFeeds(msg.data.feeds)],
        ['brief:update-all-feeds', msg => FeedUpdateService.updateAllFeeds()],
        ['brief:stop-updating', msg => FeedUpdateService.stopUpdating()],

        ['brief:get-feed-list', msg => Storage.getAllFeeds(msg.data.includeFolders, msg.data.includeHidden)],
        ['brief:get-feed', msg => Storage.getFeed(msg.data.feedID)],
        ['brief:modify-feed', msg => Storage.changeFeedProperties(msg.data)],
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

    // nsIMessageListener for content process communication
    receiveMessage: function BriefService_receiveMessage(message) {
        let {name, data} = message;
        let handler = this.handlers.get(name);
        if(handler === undefined) {
            log("BriefService: no handler for " + name);
            return;
        }
        let reply = handler(message);
        if(reply.then !== undefined) {
            return this._asyncReply(message, reply);
        } else {
            return reply;
        }
    },
    _asyncReply: function BriefService__asyncReply(message, reply) {
        let index = this._replyCounter;
        this._replyCounter += 1;
        let reply_to = message.target.messageManager;
        reply.then(value => reply_to.sendAsyncMessage('brief:async-reply',
                {id: index, payload: value}));
        return index;
    },
    _replyCounter: 0,

    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                           Ci.mozIStorageVacuumParticipant])

}

let NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefService]);
