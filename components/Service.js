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

    this._observers = new Set();
    // Register API handlers
    this.handlers = new Map([
        ['brief:add-observer', msg => this._observers.add(msg.target.messageManager)],
        ['brief:remove-observer', msg => this._observers.delete(msg.target.messageManager)],
        ['brief:get-locale', msg => Cc['@mozilla.org/chrome/chrome-registry;1']
                .getService(Ci.nsIXULChromeRegistry).getSelectedLocale('brief')],

        ['brief:get-update-status', msg => FeedUpdateService.getStatus()],
        ['brief:update-feeds', msg => FeedUpdateService.updateFeeds(msg.data.feeds)],
        ['brief:update-all-feeds', msg => FeedUpdateService.updateAllFeeds()],
        ['brief:stop-updating', msg => FeedUpdateService.stopUpdating()],

        ['brief:get-feed-list', msg => Storage.getAllFeeds(msg.data.includeFolders, msg.data.includeHidden)],
        ['brief:get-feed', msg => Storage.getFeed(msg.data.feedID)],
        ['brief:modify-feed', msg => Storage.changeFeedProperties(msg.data)],
        ['brief:get-tag-list', msg => Storage.getAllTags()],
    ]);
    for(let name of this.handlers.keys()) {
        Services.mm.addMessageListener(name, this, false);
    }

    const OBSERVER_TOPICS = [
        'brief:feed-update-queued',
        'brief:feed-update-finished',
        'brief:feed-updated',
        'brief:feed-loading',
        'brief:feed-error',
        'brief:invalidate-feedlist',
        'brief:feed-title-changed',
        'brief:feed-favicon-changed',
        'brief:custom-style-changed',
    ];
    for(let topic of OBSERVER_TOPICS) {
        Services.obs.addObserver(this, topic, false);
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

    // nsIObserver for proxying notifications to content process
    observe: function(subject, topic, data) {
        // Just forward everything downstream
        for(let obs of this._observers) {
            try {
                obs.sendAsyncMessage('brief:notify-observer', {topic, data});
            } catch(e) {
                // Looks like the receiver is gone
                this._observers.delete(obs);
            }
        }
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
        if(!message.sync)
            return;
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
