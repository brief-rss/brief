'use strict';

const EXPORTED_SYMBOLS = ['BriefClient', 'BriefServer'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import("resource://gre/modules/PromiseUtils.jsm");
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

// The following sections should not get imported in a content process
XPCOMUtils.defineLazyModuleGetter(this, 'Services', 'resource://gre/modules/Services.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'PlacesUtils', 'resource://gre/modules/PlacesUtils.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'RecentWindow', 'resource:///modules/RecentWindow.jsm');

XPCOMUtils.defineLazyModuleGetter(this, 'Storage', 'resource://brief/Storage.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'Query', 'resource://brief/Storage.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'FeedUpdateService', 'resource://brief/FeedUpdateService.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'OPML', 'resource://brief/opml.jsm');

XPCOMUtils.defineLazyGetter(this, 'Prefs', () => Services.prefs.getBranch('extensions.brief.'));



// The table of all API calls used by both BriefClient and BriefServer
// name: [topic, type, handler]
const API_CALLS = {
    // FeedUpdateService
    addFeed: ['brief:add-feed', 'async',
        url => FeedUpdateService.addFeed(url)
    ],
    getUpdateServiceStatus: ['brief:get-update-status', 'async',
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
    modifyFeed: ['brief:modify-feed', 'async',
        (properties) => Storage.changeFeedProperties(properties)
    ],
    deleteFeed: ['brief:delete-feed', 'async',
        (feed) => Storage.deleteFeed(feed)
    ],
    deleteFolder: ['brief:delete-folder', 'async',
        (folder) => Storage.deleteFolder(folder)
    ],

    // Misc helpers
    openLibrary: ['brief:open-library', 'noreply',
        () => Utils.openLibrary()
    ],
    openFeedProperties: ['brief:open-feed-properties', 'noreply',
        feedID => Utils.window.openDialog('chrome://brief/content/options/feed-properties.xul',
            'FeedProperties', 'chrome,titlebar,toolbar,centerscreen,modal', feedID)
    ],

    opml: {
        importFeeds: ['brief:opml:import-feeds', 'async',
            () => OPML.importFile()
        ],
        exportFeeds: ['brief:opml:export-feeds', 'async',
            () => OPML.exportFeeds()
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
    'brief:feed-view-mode-changed',
    'brief:custom-style-changed',
];

const Utils = {
    get window() { return RecentWindow.getMostRecentBrowserWindow() },

    openLibrary: function() {
        // The library view needs the complete ancestor list to the home folder
        let current = Prefs.getIntPref('homeFolder');
        let homePath = [current];
        while(!PlacesUtils.isRootItem(current)) {
            current = PlacesUtils.bookmarks.getFolderIdForItem(current);
            homePath.push(current);
        }
        homePath = homePath.reverse();

        this.window.PlacesCommandHook.showPlacesOrganizer(homePath);
    },

};


// BriefClient is the client API manager
function BriefClient(window) {
    // Initialize internal state
    this._mm = window.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDocShell)
        .QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIContentFrameMessageManager);
    this._observers = new Set();
    this._storageObservers = new Set();
    this._expectedReplies = new Map();
    this._requestId = 0;

    // Subscribe for the server
    this._handlers = new Map([
        ['brief:async-reply', data => this._receiveAsyncReply(data)],
        ['brief:notify-observer', data => this.notifyObservers(null, data.topic, data.data)],
        ['brief:notify-storage-observer', ({event, args}) => this.notifyStorageObservers(event, args)],
        ['brief:connect-observers', (smth) => this._mm.sendAsyncMessage('brief:add-observer')],
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

    // Manage storage observers
    addStorageObserver: function BriefClient_addStorageObserver(target) {
        this._storageObservers.add(target);
    },
    removeStorageObserver: function BriefClient_removeStorageObserver(target) {
        this._storageObservers.delete(target);
    },
    notifyStorageObservers: function BriefClient_notifyStorageObservers(event, args) {
        for(let obs of this._storageObservers) {
            obs.observeStorage(event, args);
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
                        target[name] = ((...args) => this._mm.sendAsyncMessage(topic, {args}));
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
    Storage.addObserver(this);
    Services.mm.broadcastAsyncMessage('brief:connect-observers');
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
        Storage.removeObserver(this);
        log("Brief: finalized BriefServer");
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

    observeStorage: function(event, args) {
        for(let obs of this._observers) {
            try {
                obs.sendAsyncMessage('brief:notify-storage-observer', {event, args});
            } catch(e) {
                log("API: dropping dead observer");
                // Looks like the receiver is gone
                this._observers.delete(obs);
            }
        }
    },

    // nsIMessageListener for content process communication
    receiveMessage: function BriefService_receiveMessage(message) {
        let {name, data, target: {messageManager}} = message;
        let {args, id} = data || {};
        let handler_data = this._handlers.get(name);
        if(handler_data === undefined) {
            log("BriefService: no handler for " + name);
            return;
        }
        let {type, handler, raw} = handler_data;
        let reply = (raw === true) ? handler.call(this, message) : handler.apply(this, args);
        if(type === 'async') {
            Promise.resolve(reply).then(
                payload => messageManager.sendAsyncMessage('brief:async-reply', {id, payload}));
        }
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
