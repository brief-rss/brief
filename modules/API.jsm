const EXPORTED_SYMBOLS = ['BriefClient', 'BriefServer'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Storage.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import("resource://gre/modules/PromiseUtils.jsm");
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');


XPCOMUtils.defineLazyGetter(this, 'Prefs', () => {
    return Services.prefs.getBranch('extensions.brief.');
})

// The table of all API calls used by both BriefClient and BriefServer
// name: [topic, type, handler]
const API_CALLS = {
    // FeedUpdateService
    getUpdateServiceStatus: ['brief:get-update-status', 'sync',
        () => FeedUpdateService.getStatus()
    ],
    updateFeeds: ['brief:update-feeds', 'noreply',
        feeds => FeedUpdateService.updateFeeds(feeds)
    ],
    updateAllFeeds: ['brief:update-all-feeds', 'noreply',
        () => FeedUpdateService.updateAllFeeds()
    ],
    stopUpdating: ['brief:stop-updating', 'noreply',
        () => FeedUpdateService.stopUpdating()
    ],

    // Storage
    getAllFeeds: ['brief:get-feed-list', 'sync',
        (includeFolders, includeHidden) => Storage.getAllFeeds(includeFolders, includeHidden)
    ],
    getFeed: ['brief:get-feed', 'sync',
        (feedID) => Storage.getFeed(feedID)
    ],
    modifyFeed: ['brief:modify-feed', 'sync',
        (properties) => Storage.changeFeedProperties(properties)
    ],
    getAllTags: ['brief:get-tag-list', 'async',
        () => Storage.getAllTags()
    ],

    // Misc helpers
    getLocale: ['brief:get-locale', 'sync',
        () => Cc['@mozilla.org/chrome/chrome-registry;1']
            .getService(Ci.nsIXULChromeRegistry).getSelectedLocale('brief')
    ],
    savePersistence: ['brief:save-persistence', 'noreply',
        (data) => Prefs.setCharPref("pagePersist", JSON.stringify(data))
    ],

    // Mirrors the Query actions
    query: {
        /* getEntries */
        /* getFullEntries */
        /* getProperty */
        getEntryCount: ['brief:query:count-entries', 'async',
            (query) => new Query(query).getEntryCount()
        ],
        markEntriesRead: ['brief:query:mark-read', 'async',
            (query, state) => new Query(query).markEntriesRead(state)
        ],
        /* deleteEntries */
        bookmarkEntries: ['brief:query:bookmark', 'async',
            (query, state) => new Query(query).bookmarkEntries(state)
        ],
        verifyBookmarksAndTags: ['brief:query:verify-bookmarks', 'async',
            (query) => new Query(query).verifyBookmarksAndTags()
        ],
    },

};

// The list of observer notifications to be forwarded to clients
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


// BriefClient is the client API manager
function BriefClient(window) {
    // Initialize internal state
    this._mm = window.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDocShell)
        .QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIContentFrameMessageManager);
    this._observers = new Set();
    this._expectedReplies = new Map();
    this._requestId = 0;

    // Subscribe for the server
    this._handlers = new Map([
        ['brief:async-reply', data => this._receiveAsyncReply(data)],
        ['brief:notify-observer', data => this.notifyObservers(null, data.topic, data.data)],
    ]);
    for(let name of this._handlers.keys()) {
        this._mm.addMessageListener(name, this);
    }
    this._mm.sendAsyncMessage('brief:add-observer');

    // Initialize the API functions
    this._installEndpoints(API_CALLS);
};

BriefClient.prototype = {
    // Lifecycle
    finalize: function BriefClient_finalize() {
        // Unsubscribe from the server
        this._mm.sendAsyncMessage('brief:remove-observer');
        for(let name of this._handlers.keys()) {
            this._mm.removeMessageListener(name, this);
        }
    },

    // Manage observers subscribed to the client API
    addObserver: function BriefClient_addObserver(target) {
        this._observers.add(target);
    },
    removeObserver: function BriefClient_removeObserver(target) {
        this._observers.delete(target);
    },
    notifyObservers: function BriefClient_notifyObservers(subject, topic, data) {
        for(let obs of this._observers) {
            obs.observe(subject, topic, data);
        }
    },

    // nsIMessageListener for server communication
    receiveMessage: function BriefClient_receiveMessage(message) {
        let {name, data} = message;
        let handler = this._handlers.get(name);
        if(handler === undefined) {
            log("BriefClient: no handler for " + name);
            return;
        }
        return handler(data);
    },
    _asyncRequest: function BriefClient__asyncRequest(topic, args) {
        let id = this._requestId;
        this._requestId += 1;
        let deferred = PromiseUtils.defer();
        this._expectedReplies.set(id, deferred);
        this._mm.sendAsyncMessage(topic, {args, id});
        return deferred.promise;
    },
    _receiveAsyncReply: function BriefClient__receiveAsyncReply(data) {
        let {id, payload} = data;
        let deferred = this._expectedReplies.get(id);
        if(deferred === undefined) {
            log("BriefClient: unexpected reply" + id);
            return;
        }
        this._expectedReplies.delete(id);
        deferred.resolve(payload);
    },

    // Constructor helpers
    _installEndpoints: function BriefClient__installEndpoints(endpoints, target) {
        if(target === undefined)
            target = this;
        for(let name in endpoints) {
            let value = endpoints[name];
            if(value instanceof Array) {
                let [topic, type, handler] = value;
                switch(type) {
                    case 'noreply':
                        target[name] = ((...args) => this._mm.sendAsyncMessage(topic, args));
                        break;
                    case 'sync':
                        target[name] = ((...args) => this._mm.sendRpcMessage(topic, args)[0]);
                        break;
                    case 'async':
                        target[name] = ((...args) => this._asyncRequest(topic, args));
                        break;
                }
            } else {
                target[name] = {};
                this._installEndpoints(value, target[name]);
            }
        }
    },
};


// BriefServer
function BriefServer() {
    // Initialize internal state
    this._observers = new Set();
    this._handlers = new Map([
        ['brief:add-observer', {type: 'noreply', raw: true,
            handler: msg => this._observers.add(msg.target.messageManager)}],
        ['brief:remove-observer', {type: 'noreply', raw: true,
            handler: msg => this._observers.delete(msg.target.messageManager)}],
    ]);

    // Subscribe to the services
    this._installHandlers(API_CALLS);
    for(let topic of this._handlers.keys()) {
        Services.mm.addMessageListener(topic, this, false);
    }
    for(let topic of OBSERVER_TOPICS) {
        Services.obs.addObserver(this, topic, false);
    }
};

BriefServer.prototype = {
    // Lifecycle
    finalize: function BriefServer_finalize() {
        // Unsubscribe from the services
        for(let topic of this._handlers.keys()) {
            Services.mm.removeMessageListener(topic, this);
        }
        for(let topic of OBSERVER_TOPICS) {
            Services.obs.removeObserver(this, topic);
        }
    },

    // nsIObserver for proxying notifications to content process
    observe: function(subject, topic, data) {
        // Just forward everything downstream
        for(let obs of this._observers) {
            try {
                obs.sendAsyncMessage('brief:notify-observer', {topic, data});
            } catch(e) {
                log("API: dropping dead observer");
                // Looks like the receiver is gone
                this._observers.delete(obs);
            }
        }
    },

    // nsIMessageListener for content process communication
    receiveMessage: function BriefService_receiveMessage(message) {
        let {name, data} = message;
        let handler_data = this._handlers.get(name);
        if(handler_data === undefined) {
            log("BriefService: no handler for " + name);
            return;
        }
        let {type, handler, raw} = handler_data;
        if(type === 'async')
            data = data['args'];
        let reply = (raw === true) ? handler.call(this, message) : handler.apply(this, data);
        switch(type) {
            case 'noreply':
                return;
            case 'sync':
                return reply;
            case 'async':
                this._asyncReply(message, reply);
                return;
        }
    },
    _asyncReply: function BriefService__asyncReply(message, reply) {
        let {args, id} = message.data;
        let reply_to = message.target.messageManager;
        Promise.resolve(reply).then(
            value => reply_to.sendAsyncMessage('brief:async-reply', {id, payload: value}));
    },

    // Constructor helpers
    _installHandlers: function BriefService__installHandlers(handlers) {
        for(let name in handlers) {
            let value = handlers[name]
            if(value instanceof Array) {
                let [topic, type, handler] = value;
                this._handlers.set(topic, {type, handler});
            } else {
                this._installHandlers(value);
            }
        }
    },
};
