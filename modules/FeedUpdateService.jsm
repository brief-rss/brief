var EXPORTED_SYMBOLS = ['FeedUpdateService'];

const Cc = Components.classes;
const Ci = Components.interfaces;

const UPDATE_TIMER_INTERVAL = 60000; // 1 minute
const FEED_FETCHER_TIMEOUT = 25000; // 25 seconds
const FAVICON_REFRESH_INTERVAL = 14*24*60*60*1000; // 2 weeks

const FEED_ICON_URL = 'chrome://brief/skin/icon.png';

const TIMER_TYPE_ONE_SHOT = Ci.nsITimer.TYPE_ONE_SHOT;
const TIMER_TYPE_PRECISE  = Ci.nsITimer.TYPE_REPEATING_PRECISE;
const TIMER_TYPE_SLACK    = Ci.nsITimer.TYPE_REPEATING_SLACK;

Components.utils.import('resource://brief/FeedContainer.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

XPCOMUtils.defineLazyServiceGetter(this, 'ObserverService', '@mozilla.org/observer-service;1', 'nsIObserverService');
XPCOMUtils.defineLazyServiceGetter(this, 'IOService', '@mozilla.org/network/io-service;1', 'nsIIOService');
XPCOMUtils.defineLazyGetter(this, 'Prefs', function()
    Cc['@mozilla.org/preferences-service;1'].getService(Ci.nsIPrefService)
                                            .getBranch('extensions.brief.')
                                            .QueryInterface(Ci.nsIPrefBranch2)
);
XPCOMUtils.defineLazyGetter(this, 'Storage', function() {
    var tempScope = {};
    Components.utils.import('resource://brief/Storage.jsm', tempScope);
    return tempScope.Storage;
});


// Exported object exposing public properties.
var FeedUpdateService = {

    /**
     * Indicates if updating is in progress.
     */
    NOT_UPDATING: 0,
    BACKGROUND_UPDATING: 1,
    NORMAL_UPDATING: 2,

    status: 0,

    /**
     * Total number of feeds scheduled for current update batch (both completed
     * and pending ones).
     */
    get scheduledFeedsCount() {
        return FeedUpdateServiceInternal.scheduledFeeds.length;
    },

    /**
     * Number of completed feed in the current update batch.
     */
    get completedFeedsCount() {
        return FeedUpdateServiceInternal.completedFeeds.length;
    },

    /**
     * Downloads and checks for updates all the feeds in the database.
     *
     * @param aInBackground [optional]
     *        Use longer delay between requesting subsequent
     *        feeds in order to reduce the CPU load.
     */
    updateAllFeeds: function(aInBackground) {
        return FeedUpdateServiceInternal.updateAllFeeds(aInBackground);
    },

    /**
     * Downloads feeds and check them for updates.
     *
     * @param aFeeds
     *        Array of Feed objects representing feeds to be downloaded.
     * @param aInBackground [optional]
     *        Use longer delay between requesting subsequent feeds in order to
     *        reduce the CPU load.
     */
    updateFeeds: function(aFeeds, aInBackground) {
        return FeedUpdateServiceInternal.updateFeeds(aFeeds, aInBackground);
    },

    /**
     * Cancel the remaining update batch.
     */
    stopUpdating: function() {
        return FeedUpdateServiceInternal.stopUpdating();
    }
}


var FeedUpdateServiceInternal = {

    NOT_UPDATING: 0,
    BACKGROUND_UPDATING: 1,
    NORMAL_UPDATING: 2,

    status: 0,

    // Current batch of feeds to be updated (array of Feed's)
    scheduledFeeds: [],

    // Remaining feeds to be fetched in the current batch
    updateQueue:    [],

    // Feeds that have already been fetched and parsed
    completedFeeds: [],

    // Number of feeds updated in the current batch that have new entries
    feedsWithNewEntriesCount: 0,

    // Total number of new entries in the current batch
    newEntriesCount:          0,


    init: function FeedUpdateServiceInternal_init() {
        ObserverService.addObserver(this, 'brief:feed-updated', false);
        ObserverService.addObserver(this, 'quit-application', false);
        Prefs.addObserver('', this, false);

        XPCOMUtils.defineLazyGetter(this, 'updateTimer', function()
            Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer));
        XPCOMUtils.defineLazyGetter(this, 'startupDelayTimer', function()
            Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer));
        XPCOMUtils.defineLazyGetter(this, 'fetchDelayTimer', function()
             Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer));

        // Delay the initial autoupdate check in order not to slow down the startup.
        let startupDelay = Prefs.getIntPref('update.startupDelay');
        this.startupDelayTimer.initWithCallback(this, startupDelay, TIMER_TYPE_ONE_SHOT);
    },

    // See FeedUpdateService.
    updateAllFeeds: function FeedUpdateServiceInternal_updateAllFeeds(aInBackground) {
        this.updateFeeds(Storage.getAllFeeds(), aInBackground);

        Prefs.setIntPref('update.lastUpdateTime', Math.round(Date.now() / 1000));
    },

    // See FeedUpdateService.
    updateFeeds: function FeedUpdateServiceInternal_updateFeeds(aFeeds, aInBackground) {
        // Don't add the same feed be added twice.
        var newFeeds = aFeeds.filter(function(f) this.updateQueue.indexOf(f) == -1, this);

        this.scheduledFeeds = this.scheduledFeeds.concat(newFeeds);
        this.updateQueue = this.updateQueue.concat(newFeeds);

        // Start an update if it isn't in progress yet.
        if (this.status == this.NOT_UPDATING) {
            var delay = aInBackground ? Prefs.getIntPref('update.backgroundFetchDelay')
                                      : Prefs.getIntPref('update.defaultFetchDelay');

            this.fetchDelayTimer.initWithCallback(this, delay, TIMER_TYPE_SLACK);
            this.status = aInBackground ? this.BACKGROUND_UPDATING : this.NORMAL_UPDATING;

            this.fetchNextFeed();
        }
        else if (this.status == this.BACKGROUND_UPDATING && !aInBackground) {
            // Stop the background update and continue with a foreground one.
            this.fetchDelayTimer.cancel();

            var delay = Prefs.getIntPref('update.defaultFetchDelay');
            this.fetchDelayTimer.initWithCallback(this, delay, TIMER_TYPE_SLACK);
            this.status = this.NORMAL_UPDATING;

            this.fetchNextFeed();
        }

        if (newFeeds.length)
            ObserverService.notifyObservers(null, 'brief:feed-update-queued', '');
    },

    // See FeedUpdateService.
    stopUpdating: function FeedUpdateServiceInternal_stopUpdating() {
        ObserverService.notifyObservers(null, 'brief:feed-update-canceled', '');
        this.finishUpdate();
    },

    // nsITimerCallback
    notify: function FeedUpdateServiceInternal_notify(aTimer) {
        switch (aTimer) {

        case this.startupDelayTimer:
            this.updateTimer.initWithCallback(this, UPDATE_TIMER_INTERVAL, TIMER_TYPE_SLACK);
            // Fall through...

        case this.updateTimer:
            if (this.status != this.NOT_UPDATING)
                return;

            var globalUpdatingEnabled = Prefs.getBoolPref('update.enableAutoUpdate');
            // Preferencos are in seconds, because they can only store 32 bit integers.
            var globalInterval = Prefs.getIntPref('update.interval') * 1000;
            var lastGlobalUpdateTime = Prefs.getIntPref('update.lastUpdateTime') * 1000;
            var now = Date.now();

            var itsGlobalUpdateTime = globalUpdatingEnabled &&
                                      now - lastGlobalUpdateTime > globalInterval;

            // Filter feeds which need to be updated, according to either the global
            // update interval or their own feed-specific interval.
            function filter(f) (f.updateInterval == 0 && itsGlobalUpdateTime) ||
                               (f.updateInterval > 0 && now - f.lastUpdated > f.updateInterval);
            var feedsToUpdate = Storage.getAllFeeds().filter(filter);

            if (feedsToUpdate.length)
                this.updateFeeds(feedsToUpdate, feedsToUpdate.length, true);

            if (itsGlobalUpdateTime)
                Prefs.setIntPref('update.lastUpdateTime', Math.round(now / 1000));

            break;

        case this.fetchDelayTimer:
            this.fetchNextFeed();
            break;
        }
    },


    fetchNextFeed: function FeedUpdateServiceInternal_fetchNextFeed() {
        // All feeds in the update queue may have already been requested,
        // because we don't cancel the timer until after all feeds are completed.
        var feed = this.updateQueue.shift();
        if (feed)
            new FeedFetcher(feed);
    },


    onFeedUpdated: function FeedUpdateServiceInternal_onFeedUpdated(aFeed, aError, aNewEntriesCount) {
        this.completedFeeds.push(aFeed);
        this.newEntriesCount += aNewEntriesCount;
        if (aNewEntriesCount > 0)
            this.feedsWithNewEntriesCount++;

        ObserverService.notifyObservers(null, 'brief:feed-updated', aFeed.feedID);
        if (aError)
            ObserverService.notifyObservers(null, 'brief:feed-error', aFeed.feedID);

        if (this.completedFeeds.length == this.scheduledFeeds.length)
            this.finishUpdate();
    },


    finishUpdate: function FeedUpdateServiceInternal_finishUpdate() {
        this.status = this.NOT_UPDATING;
        this.fetchDelayTimer.cancel();

        var showNotification = Prefs.getBoolPref('update.showNotification');
        if (this.feedsWithNewEntriesCount > 0 && showNotification) {
            let bundle = Cc['@mozilla.org/intl/stringbundle;1']
                         .getService(Ci.nsIStringBundleService)
                         .createBundle('chrome://brief/locale/brief.properties');
            let title = bundle.GetStringFromName('feedsUpdatedAlertTitle');
            let params = [this.newEntriesCount, this.feedsWithNewEntriesCount];
            let text = bundle.formatStringFromName('updateAlertText', params, 2);

            try {
                let alertsService = Cc['@mozilla.org/alerts-service;1']
                                    .getService(Ci.nsIAlertsService);
                alertsService.showAlertNotification(FEED_ICON_URL, title, text, true, null, this);
            }
            catch (ex) {
                // Apparently nsIAlertsService may fail on OS X with Growl installed.
                Components.utils.reportError(ex);
            }
        }

        this.newEntriesCount = this.feedsWithNewEntriesCount = 0;
        this.completedFeeds = [];
        this.scheduledFeeds = [];
        this.updateQueue = [];
    },


    // nsIObserver
    observe: function FeedUpdateServiceInternal_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

        // Notification from nsIAlertsService that user has clicked the link in
        // the alert.
        case 'alertclickcallback':
            var window = Cc['@mozilla.org/appshell/window-mediator;1']
                         .getService(Ci.nsIWindowMediator)
                         .getMostRecentWindow('navigator:browser');
            if (window) {
                window.gBrief.open(true);
                window.focus();
            }
            break;

        case 'nsPref:changed':
            if (aData == 'update.enableAutoUpdate' || aData == 'update.interval')
                this.notify(this.updateTimer);
            break;

        case 'quit-application':
            ObserverService.removeObserver(this, 'brief:feed-updated');
            ObserverService.removeObserver(this, 'quit-application');
            Prefs.removeObserver('', this);
            break;

        }
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsITimerCallback, Ci.nsIObserver])

}


/**
 * This object downloads the feed, parses it and updates the database.
 *
 * @param aFeed
 *        Feed object representing the feed to be downloaded.
 */
function FeedFetcher(aFeed) {
    this.feed = aFeed;

    this.parser = Cc['@mozilla.org/feed-processor;1'].createInstance(Ci.nsIFeedProcessor);
    this.parser.listener = this;

    this.timeoutTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);

    ObserverService.notifyObservers(null, 'brief:feed-loading', this.feed.feedID);
    ObserverService.addObserver(this, 'brief:feed-update-canceled', false);

    this.requestFeed();
}

FeedFetcher.prototype = {

    feed:           null, // The passed feed, as currently stored in the database.
    downloadedFeed: null, // The downloaded feed.

    request: null,
    parser: null,
    timeoutTimer: null,

    // The feed processor sets the bozo bit when a feed triggers a fatal error during XML
    // parsing. There may still be feed metadata and entries that were parsed before the
    // error occurred.
    bozo: false,


    requestFeed: function FeedFetcher_requestFeed() {
        this.request = Cc['@mozilla.org/xmlextras/xmlhttprequest;1']
                       .createInstance(Ci.nsIXMLHttpRequest);

        this.request.mozBackgroundRequest = Prefs.getBoolPref('update.suppressSecurityDialogs');
        this.request.open('GET', this.feed.feedURL, true);
        this.request.overrideMimeType('application/xml');
        this.request.onload = onRequestLoad;
        this.request.onerror = onRequestError;
        this.request.send(null);

        this.timeoutTimer.init(this, FEED_FETCHER_TIMEOUT, TIMER_TYPE_ONE_SHOT);

        var self = this;

        function onRequestError() {
            // See /extensions/venkman/resources/content/venkman-jsdurl.js#983 et al.
            const I_LOVE_NECKO_TOO = 2152398850;

            if (self.request.channel.status == I_LOVE_NECKO_TOO) {
                self.request.abort();
                self.requestFeed();
            }
            else {
                self.finish(true);
            }
        }

        function onRequestLoad() {
            self.timeoutTimer.cancel();
            try {
                let uri = IOService.newURI(self.feed.feedURL, null, null);
                self.parser.parseFromString(self.request.responseText, uri);
            }
            catch (ex) {
                self.finish(true);
            }
        }
    },

    // nsIFeedResultListener
    handleResult: function FeedFetcher_handleResult(aResult) {
        // Prevent handleResult from being called twice, which seems to
        // sometimes happen with parsing errors.
        this.parser.listener = null;

        if (!aResult || !aResult.doc) {
            this.finish(true);
            return;
        }

        this.bozo = aResult.bozo;

        var feed = aResult.doc.QueryInterface(Ci.nsIFeed);
        this.downloadedFeed = new Feed(feed);

        // The URI that we passed and aResult.uri (which is actual URI from which the data
        // was fetched) may differ because of redirects. We want to use the former one
        // here, because that's the one which is stored in the Live Bookmark.
        this.downloadedFeed.feedURL = this.feed.feedURL;
        this.downloadedFeed.feedID = this.feed.feedID;
        this.downloadedFeed.favicon = this.feed.favicon;
        this.downloadedFeed.lastFaviconRefresh = this.feed.lastFaviconRefresh;

        var self = this;

        if (Date.now() - this.downloadedFeed.lastFaviconRefresh > FAVICON_REFRESH_INTERVAL
                || !this.downloadedFeed.favicon) {
            this.downloadedFeed.lastFaviconRefresh = Date.now();

            // We use websiteURL instead of feedURL for resolving the favicon URL,
            // because many websites use services like Feedburner for generating their
            // feeds and we'd get the Feedburner's favicon instead.
            if (this.downloadedFeed.websiteURL) {
                new FaviconFetcher(this.downloadedFeed.websiteURL, function(aFavicon) {
                    self.downloadedFeed.favicon = aFavicon;
                    Storage.processFeed(self.downloadedFeed, function(aNewEntriesCount) {
                        self.finish(self.bozo, aNewEntriesCount);
                    });
                });
                return;
            }
            else {
                this.downloadedFeed.favicon = 'no-favicon';
            }
        }

        Storage.processFeed(this.downloadedFeed, function(aNewEntriesCount) {
            self.finish(self.bozo, aNewEntriesCount);
        });
    },

    finish: function FeedFetcher_finish(aError, aNewEntriesCount) {
        FeedUpdateServiceInternal.onFeedUpdated(this.feed, aError, aNewEntriesCount || 0);
        this.cleanup();
    },

    observe: function FeedFetcher_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'timer-callback':
                this.request.abort();
                this.finish(true);
                break;

            case 'brief:feed-update-canceled':
                this.request.abort();
                this.cleanup();
                break;
            }
    },

    cleanup: function FeedFetcher_cleanup() {
        ObserverService.removeObserver(this, 'brief:feed-update-canceled');
        this.request = null;
        this.timeoutTimer.cancel();
        this.timeoutTimer = null;
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsIFeedResultListener])

}

/**
 * Downloads a favicon of a webpage and base64-encodes it.
 *
 * @param aWebsiteURL
 *        URL of webpage which favicon to download (not URI of the
 *        favicon itself).
 * @param aCallback
 *        Callback to use when finished.
 */
function FaviconFetcher(aWebsiteURL, aCallback) {
    var websiteURI = IOService.newURI(aWebsiteURL, null, null)
    var faviconURI = IOService.newURI(websiteURI.prePath + '/favicon.ico', null, null);

    var chan = IOService.newChannelFromURI(faviconURI);
    chan.notificationCallbacks = this;
    chan.asyncOpen(this, null);

    this.callback = aCallback;
    this.websiteURI = websiteURI;
    this._channel = chan;
    this._bytes = [];
}

FaviconFetcher.prototype = {

    websiteURI:  null,

    _channel:   null,
    _countRead: 0,
    _stream:    null,

    // nsIRequestObserver
    onStartRequest: function FaviconFetcher_lonStartRequest(aRequest, aContext) {
        this._stream = Cc['@mozilla.org/binaryinputstream;1']
                       .createInstance(Ci.nsIBinaryInputStream);
    },

    onStopRequest: function FaviconFetcher_onStopRequest(aRequest, aContext, aStatusCode) {
        var requestFailed = !Components.isSuccessCode(aStatusCode);
        if (!requestFailed && (aRequest instanceof Ci.nsIHttpChannel))
            requestFailed = !aRequest.requestSucceeded;

        if (!requestFailed && this._countRead != 0) {
            let base64DataString =  btoa(String.fromCharCode.apply(null, this._bytes))
            var favicon = 'data:image/x-icon;base64,' + base64DataString;
        }
        else {
            favicon = 'no-favicon';
        }

        this.callback(favicon);

        this._channel = null;
        this._element  = null;
    },

    // nsIStreamListener
    onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
        this._stream.setInputStream(aInputStream);

        // Get a byte array of the data
        this._bytes = this._bytes.concat(this._stream.readByteArray(aCount));
        this._countRead += aCount;
    },

    // nsIChannelEventSink
    onChannelRedirect: function(aOldChannel, aNewChannel, aFlags) {
        this._channel = aNewChannel;
    },

    getInterface: function(aIID) this.QueryInterface(aIID),                 // nsIInterfaceRequestor
    confirmUnknownIssuer: function(aSocketInfo, aCert, aCertAddType) false, // nsIBadCertListener
    confirmMismatchDomain: function(aSocketInfo, aTargetURL, aCert) false,
    confirmCertExpired: function(aSocketInfo, aCert) false,
    notifyCrlNextupdate: function(aSocketInfo, aTargetURL, aCert) { },
    onRedirect: function(aChannel, aNewChannel) { },                        // nsIHttpEventSink
    onProgress: function(aRequest, aContext, aProgress, aProgressMax) { },  // nsIProgressEventSink
    onStatus: function(aRequest, aContext, aStatus, aStatusArg) { },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIRequestObserver],
                                          [Ci.nsIStreamListener],
                                          [Ci.nsIChannelEventSink],
                                          [Ci.nsIInterfaceRequestor],
                                          [Ci.nsIBadCertListener],
                                          [Ci.nsIPrompt],
                                          [Ci.nsIHttpEventSink],
                                          [Ci.nsIProgressEventSink])

}


function log(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1']
                       .getService(Ci.nsIConsoleService);
  consoleService.logStringMessage(aMessage);
}


FeedUpdateServiceInternal.init();
