const EXPORTED_SYMBOLS = ['BriefClient', 'BriefServer'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Storage.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import("resource://gre/modules/PromiseUtils.jsm");
Components.utils.import("resource://gre/modules/PlacesUtils.jsm");
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'RecentWindow', 'resource:///modules/RecentWindow.jsm');
XPCOMUtils.defineLazyModuleGetter(this, 'OPML', 'resource://brief/opml.jsm');



XPCOMUtils.defineLazyGetter(this, 'Prefs', () => {
    return Services.prefs.getBranch('extensions.brief.');
})

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
    ready: ['brief:storage-ready', 'async',
        () => Storage.ready
    ],
    getAllFeeds: ['brief:get-feed-list', 'sync',
        (includeFolders, includeHidden) => Storage.getAllFeeds(includeFolders, includeHidden)
    ],
    modifyFeed: ['brief:modify-feed', 'sync',
        (properties) => Storage.changeFeedProperties(properties)
    ],
    getAllTags: ['brief:get-tag-list', 'async',
        () => Storage.getAllTags()
    ],
    deleteTag: ['brief:delete-tag', 'async',
        (tag) => Storage.deleteTag(tag)
    ],
    deleteFeed: ['brief:delete-feed', 'async',
        (feed) => Storage.deleteFeed(feed)
    ],
    deleteFolder: ['brief:delete-folder', 'async',
        (folder) => Storage.deleteFolder(folder)
    ],

    // Misc helpers
    getLocale: ['brief:get-locale', 'sync',
        () => Cc['@mozilla.org/chrome/chrome-registry;1']
            .getService(Ci.nsIXULChromeRegistry).getSelectedLocale('brief')
    ],
    savePersistence: ['brief:save-persistence', 'noreply',
        (data) => Prefs.setCharPref("pagePersist", JSON.stringify(data))
    ],
    openLibrary: ['brief:open-library', 'noreply',
        () => Utils.openLibrary()
    ],
    openShortcuts: ['brief:open-shortcuts', 'noreply',
        () => Utils.openShortcuts()
    ],
    openOptions: ['brief:open-options', 'noreply',
        () => Utils.openOptions()
    ],
    openFeedProperties: ['brief:open-feed-properties', 'noreply',
        feedID => Utils.window.openDialog('chrome://brief/content/options/feed-properties.xul',
            'FeedProperties', 'chrome,titlebar,toolbar,centerscreen,modal', feedID)
    ],
    getXulPersist: ['brief:get-xul-persist', 'async',
        () => Utils.getXulPersist()
    ],
    openBackgroundTab: ['brief:open-background-tab', 'async',
        url => Utils.window.gBrowser.loadOneTab(url, {relatedToCurrent: true})
    ],
    hideStarUI: ['brief:hide-star-ui', 'async',
        () => Utils.window.StarUI.panel.hidePopup()
    ],
    showStarUI: ['brief:show-star-ui', 'async',
        ({id, rect}) => Utils.showStarUI({id, rect})
    ],

    // Mirrors the Query actions
    query: {
        getEntries: ['brief:query:get-entries', 'async',
            (query) => new Query(query).getEntries()
        ],
        getFullEntries: ['brief:query:get-full-entries', 'async',
            (query) => new Query(query).getFullEntries()
        ],
        getProperty: ['brief:query:get-property', 'async',
            (query, name, distinct) => new Query(query).getProperty(name, distinct)
        ],
        getEntryCount: ['brief:query:count-entries', 'async',
            (query) => new Query(query).getEntryCount()
        ],
        markEntriesRead: ['brief:query:mark-read', 'async',
            (query, state) => new Query(query).markEntriesRead(state)
        ],
        deleteEntries: ['brief:query:delete', 'async',
            (query, state) => new Query(query).deleteEntries(state)
        ],
        bookmarkEntries: ['brief:query:bookmark', 'async',
            (query, state) => new Query(query).bookmarkEntries(state)
        ],
        verifyBookmarksAndTags: ['brief:query:verify-bookmarks', 'async',
            (query) => new Query(query).verifyBookmarksAndTags()
        ],
    },

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
    BRIEF_XUL_URL: 'chrome://brief/content/brief.xul',

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

    openShortcuts: function() {
        let url = 'chrome://brief/content/keyboard-shortcuts.xhtml';

        let windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            let win = windows.getNext();
            if (win.document.documentURI == url) {
                win.focus();
                return;
            }
        }

        let height = Math.min(this.window.screen.availHeight, 650);
        let features = 'chrome,centerscreen,titlebar,resizable,width=500,height=' + height;

        this.window.openDialog(url, 'Brief shortcuts', features);
    },

    openOptions: function() {
        let url = 'chrome://brief/content/options/options.xul';

        let windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            let win = windows.getNext();
            if (win.document.documentURI == url) {
                win.focus();
                return;
            }
        }

        let features = 'chrome,titlebar,toolbar,centerscreen,';
        this.window.openDialog(url, 'Brief options', features);
    },

    getXulPersist: function() {
        let store = Cc["@mozilla.org/xul/xulstore;1"].getService(Ci.nsIXULStore);
        return {
            startView: store.getValue(this.BRIEF_XUL_URL, "view-list", "startview"),
            closedFolders: store.getValue(this.BRIEF_XUL_URL, "feed-list", "closedFolders"),
            tagList: {
                width: store.getValue(this.BRIEF_XUL_URL, "tag-list", "width") + 'px'
            },
            sidebar: {
                width: store.getValue(this.BRIEF_XUL_URL, "sidebar", "width") + 'px',
                hidden: store.getValue(this.BRIEF_XUL_URL, "sidebar", "hidden")
            },
        }
    },

    showStarUI: function Utils_showStarUI({id, rect}) {
        let StarUI = this.window.StarUI;
        StarUI.panel.addEventListener('popupshown', () => {
            let x = rect.left + rect.width / 2 - this.window.mozInnerScreenX;
            let y = rect.top + rect.height - this.window.mozInnerScreenY;
            this.window.StarUI.panel.moveToAnchor(null, '', x, y, false, false, null);
        });
        StarUI.showEditBookmarkPopup(id, this.window.gBrowser, "after_start", false);
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
    Storage.addObserver(this);
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
