const CLASS_ID    = Components.ID('{13A031E4-7EE9-11DB-8E2E-A58155D89593}');
const CLASS_NAME  = 'Feed updating service for the Brief extension';
const CONTRACT_ID = '@ancestor/brief/updateservice;1';

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

const TIMER_TYPE_ONE_SHOT = Ci.nsITimer.TYPE_ONE_SHOT;
const TIMER_TYPE_PRECISE  = Ci.nsITimer.TYPE_REPEATING_PRECISE;
const TIMER_TYPE_SLACK    = Ci.nsITimer.TYPE_REPEATING_SLACK;

const ICON_DATAURL_PREFIX = 'data:image/x-icon;base64,';
const FEED_ICON_URL       = 'chrome://brief/skin/icon.png';

const UPDATE_TIMER_INTERVAL = 120000; // 2 minutes
const STARTUP_DELAY = 5000; // 5 seconds
const FEED_FETCHER_TIMEOUT = 15000; // 15 seconds

const NO_UPDATE = Ci.nsIBriefUpdateService.NO_UPDATE;
const NORMAL_UPDATE = Ci.nsIBriefUpdateService.NORMAL_UPDATE;
const BACKGROUND_UPDATE = Ci.nsIBriefUpdateService.BACKGROUND_UPDATE;

function dump(aMessage) {
  var consoleService = Cc["@mozilla.org/consoleservice;1"].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage('Brief:\n' + aMessage);
}

var gBriefUpdateService = null;

// Class definition
function BriefUpdateService() {
    this.updateTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
    this.fetchDelayTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
    this.prefs = Cc['@mozilla.org/preferences-service;1'].
                 getService(Ci.nsIPrefService).
                 getBranch('extensions.brief.').
                 QueryInterface(Ci.nsIPrefBranch2);

    // Unfortunately alerts don't work on all platforms
    if (Ci.nsIAlertsService && '@mozilla.org/alerts-service;1' in Cc) {
        this.alertsService = Cc['@mozilla.org/alerts-service;1'].
                             getService(Ci.nsIAlertsService);
    }

    var observerService = Cc['@mozilla.org/observer-service;1'].
                          getService(Ci.nsIObserverService);
    observerService.addObserver(this, 'brief:feed-updated', false);
    observerService.addObserver(this, 'brief:feed-error', false);
    observerService.addObserver(this, 'profile-after-change', false);
}

BriefUpdateService.prototype = {

    // nsIBriefUpdateService
    autoUpdatingEnabled: false,

    // nsIBriefUpdateService
    get totalFeedsCount() {
        return this.scheduledFeeds.length;
    },

    // nsIBriefUpdateService
    get completedFeedsCount() {
        return this.completedFeeds.length;
    },

    // nsIBriefUpdateService
    updateInProgress: NO_UPDATE,

    scheduledFeeds: [],  // feeds to be updated in the current job (array of nsIBriefFeed's)
    updateQueue:    [],  // remaining feeds to be fetched
    completedFeeds: [],  // feeds which have been fetched and parsed

    updateCanceled: false,

    feedsWithNewEntriesCount: 0,  // number of updated feeds that have new entries
    newEntriesCount:          0,  // total number of new entries in all updated feeds

    updateTimer:     null,
    fetchDelayTimer: null,
    prefs:           null,


    // nsIBriefUpdateService
    enableAutoUpdating: function BUS_enableAutoUpdating() {
        if (this.autoUpdatingEnabled)
            throw('Brief: update service is already running.')
        this.autoUpdatingEnabled = true;

        // Notify the timer to immediately check if feeds need to be updated.
        this.notify(this.updateTimer);

        // Start the update timer which is responsible of periodically checking if enough
        // time has passed since last update.
        this.updateTimer.initWithCallback(this, UPDATE_TIMER_INTERVAL, TIMER_TYPE_SLACK);
    },


    // nsIBriefUpdateService
    disableAutoUpdating: function BUS_disableAutoUpdating() {
        if (!this.autoUpdatingEnabled)
            throw('Brief: update service is not running.');

        this.updateTimer.cancel();
        this.autoUpdatingEnabled = false;
    },


    // nsIBriefUpdateService
    fetchAllFeeds: function BUS_fetchAllFeeds(aInBackground) {
        var storageService = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
        var feeds = storageService.getAllFeeds({});
        this.fetchFeeds(feeds, feeds.length, aInBackground);
    },


    fetchFeeds: function BUS_fetchFeeds(aFeeds, aFeedsLength, aInBackground) {
        // If only one feed is to be updated, we just do it right away without maintaining
        // the update queue.
        if (this.updateInProgress == NO_UPDATE && aFeeds.length == 1) {
            new FeedFetcher(aFeeds[0]);
            return;
        }

        // Add feeds to the queue, but don't let the same feed to be added twice.
        var feed, i;
        var oldLength = this.scheduledFeeds.length;
        for (i = 0; i < aFeeds.length; i++) {
            feed = aFeeds[i];
            if (this.scheduledFeeds.indexOf(feed) == -1) {
                this.scheduledFeeds.push(feed);
                this.updateQueue.push(feed);
            }
        }

        // Start updating if it isn't in progress yet. We will fetch feeds on an interval,
        // so we don't choke when downloading and processing all of them a once.
        if (this.updateInProgress == NO_UPDATE) {
            var delay = aInBackground ? this.prefs.getIntPref('update.backgroundFetchDelay')
                                      : this.prefs.getIntPref('update.defaultFetchDelay');
            this.fetchDelayTimer.initWithCallback(this, delay, TIMER_TYPE_SLACK);
        }

        // If background update is in progress and foreground update is attempted,
        // we stop the background start continue with a foreground one.
        if (this.updateInProgress == BACKGROUND_UPDATE && !aInBackground) {
            this.fetchDelayTimer.cancel();
            var delay = this.prefs.getIntPref('update.defaultFetchDelay');
            this.fetchDelayTimer.initWithCallback(this, delay, TIMER_TYPE_SLACK);
        }

        if (this.updateInProgress != NORMAL_UPDATE)
            this.updateInProgress = aInBackground ? BACKGROUND_UPDATE : NORMAL_UPDATE;

        if (oldLength < this.scheduledFeeds.length) {
            var data = this.updateInProgress == BACKGROUND_UPDATE ? 'background' : 'foreground';
            var observerService = Cc['@mozilla.org/observer-service;1'].
                                  getService(Ci.nsIObserverService);
            observerService.notifyObservers(null, 'brief:feed-update-queued', data);
        }
    },


    stopFetching: function BUS_stopFetching() {
        this.finishUpdate();
        this.updateCanceled = true;
        var observerService = Cc['@mozilla.org/observer-service;1'].
                              getService(Ci.nsIObserverService);
        observerService.notifyObservers(null, 'brief:feed-update-canceled', '');
    },


    // nsITimerCallback
    notify: function BUS_notify(aTimer) {
        switch (aTimer) {

        case this.startupDelayTimer:
            this.enableAutoUpdating();
            this.startupDelayTimer = null;
            break;

        case this.updateTimer:
            var interval = this.prefs.getIntPref('update.interval');
            var lastUpdateTime = this.prefs.getIntPref('update.lastUpdateTime');
            var now = Math.round(Date.now() / 1000);
            if (now - lastUpdateTime >= interval*60)
                this.fetchAllFeeds(true);
            break;

        case this.fetchDelayTimer:
            var feed = this.updateQueue.shift();

            // All feeds in the update queue may have already been requested,
            // because we don't cancel the timer until after all feeds are completed.
            if (feed)
                new FeedFetcher(feed);

            break;
        }
    },


    finishUpdate: function BUS_finishUpdate() {
        this.updateInProgress = NO_UPDATE;
        this.fetchDelayTimer.cancel();

        var showNotification = this.prefs.getBoolPref('update.showNotification');
        if (this.feedsWithNewEntriesCount > 0 && showNotification && this.alertsService) {

            var bundle = Cc['@mozilla.org/intl/stringbundle;1'].
                         getService(Ci.nsIStringBundleService).
                         createBundle('chrome://brief/locale/brief.properties');
            var title = bundle.GetStringFromName('feedsUpdatedAlertTitle');
            var params = [this.newEntriesCount, this.feedsWithNewEntriesCount];
            var text = bundle.formatStringFromName('updateAlertText', params, 2);

            this.alertsService.showAlertNotification(FEED_ICON_URL, title, text,
                                                     true, null, this);
        }

        // If it was a full update, set the pref.
        var storageService = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
        if (this.scheduledFeeds.length == storageService.getAllFeeds({}).length) {
            var now = Math.round(Date.now() / 1000);
            this.prefs.setIntPref('update.lastUpdateTime', now);
        }

        // Reset the properties after updating is finished.
        this.newEntriesCount = this.feedsWithNewEntriesCount = 0;
        this.completedFeeds = [];
        this.scheduledFeeds = [];
        this.updateQueue = [];
        this.updateCanceled = false;
    },


    // nsIObserver
    observe: function BUS_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

        // Startup initialization. We use this instead of app-startup,
        // so that the preferences are already initialized.
        case 'profile-after-change':
            if (aData == 'startup') {
                if (this.prefs.getBoolPref('update.enableAutoUpdate')) {
                    // Delay enabling autoupdate, so not to slow down the startup. Plus,
                    // nsIBriefStorage is instantiated on profile-after-change.
                    this.startupDelayTimer = Cc['@mozilla.org/timer;1'].
                                             createInstance(Ci.nsITimer);
                    this.startupDelayTimer.initWithCallback(this, STARTUP_DELAY, TIMER_TYPE_ONE_SHOT);
                }

                // We add the observer here instead of in the constructor as prefs
                // are changed during startup when assuming their user-set values.
                this.prefs.addObserver('', this, false);
            }
            break;

        // Count updated feeds, so we can show their number in the alert when
        // updating is completed.
        case 'brief:feed-error':
        case 'brief:feed-updated':
            // If |updateInProgress| is NO_UPDATE then it means that a single feed was
            // requested - nothing to do here as batch update wasn't started.
            if (this.updateInProgress == NO_UPDATE || this.updateCanceled)
                return;

            if (aSubject && aSubject.QueryInterface(Ci.nsIVariant) > 0) {
                this.newEntriesCount += aSubject.QueryInterface(Ci.nsIVariant);
                this.feedsWithNewEntriesCount++;
            }

            // We're done, all feeds updated.
            if (this.completedFeeds.length == this.scheduledFeeds.length)
                this.finishUpdate();

            break;

        // Notification from nsIAlertsService that user has clicked the link in
        // the alert.
        case 'alertclickcallback':
            var window = Cc['@mozilla.org/appshell/window-mediator;1'].
                         getService(Ci.nsIWindowMediator).
                         getMostRecentWindow("navigator:browser");
            if (window) {
                window.gBrief.openBrief(true);
                window.focus();
            }
            break;

        case 'nsPref:changed':
            switch (aData) {
            case 'update.enableAutoUpdate':
                var newValue = this.prefs.getBoolPref('update.enableAutoUpdate');
                if (!newValue && this.autoUpdatingEnabled)
                    this.disableAutoUpdating();
                if (newValue && !this.autoUpdatingEnabled)
                    this.enableAutoUpdating();
                break;

            case 'update.interval':
                var updateEnabled = this.prefs.getBoolPref('update.enableAutoUpdate');
                if (this.autoUpdatingEnabled)
                    this.disableAutoUpdating();
                if (updateEnabled)
                    this.enableAutoUpdating();
                break;
            }
            break;
        }
    },


    // nsISupports
    QueryInterface: function BUS_QueryInterface(aIID) {
        if (!aIID.equals(Components.interfaces.nsIBriefUpdateService) &&
            !aIID.equals(Components.interfaces.nsISupports) &&
            !aIID.equals(Components.interfaces.nsITimerCallback) &&
            !aIID.equals(Components.interfaces.nsIObserver))
            throw Components.results.NS_ERROR_NO_INTERFACE;
        return this;
    }

}


/**
 * This object downloads the feed, parses it and updates the database.
 *
 * @param aFeed nsIFeed object representing the feed to be downloaded.
 */
function FeedFetcher(aFeed) {
    this.feed = aFeed;
    this.favicon = aFeed.favicon;

    this.observerService = Cc['@mozilla.org/observer-service;1'].
                           getService(Ci.nsIObserverService);
    this.observerService.notifyObservers(null, 'brief:feed-loading', this.feed.feedID);
    this.observerService.addObserver(this, 'brief:feed-update-canceled', false);
    this.timeoutTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);

    this.requestFeed();
}

FeedFetcher.prototype = {

    feed: null,           // The passed feed, as currently stored in the database.
    downloadedFeed: null, // The downloaded feed. Initially null.
    favicon: '',          // The feed's favicon. Initially set to what's currently in the database.

    request: null,
    timeoutTimer: null,
    observerService: null,

    // Indicates if the request has encountered an error (either a connection error or
    // parsing error) and have sent 'brief:feed-error' notification.
    inError: false,


    requestFeed: function FeedFetcher_requestFeed() {
        var self = this;

        function onRequestError() {
            self.finish(false);
        }

        function onRequestLoad() {
            self.timeoutTimer.cancel();

            var ioService = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
            var uri = ioService.newURI(self.feed.feedURL, null, null);
            var parser = Cc['@mozilla.org/feed-processor;1'].createInstance(Ci.nsIFeedProcessor);
            parser.listener = self;

            try {
                parser.parseFromString(self.request.responseText, uri);
            }
            catch(e) {
                self.finish(false);
            }
        }

        this.request = Cc['@mozilla.org/xmlextras/xmlhttprequest;1'].
                       createInstance(Ci.nsIXMLHttpRequest);
        this.request.open('GET', this.feed.feedURL, true);
        this.request.overrideMimeType('application/xml');
        this.request.onload = onRequestLoad;
        this.request.onerror = onRequestError;
        this.request.send(null);

        this.timeoutTimer.init(this, FEED_FETCHER_TIMEOUT, TIMER_TYPE_ONE_SHOT);
    },


    // nsIFeedResultListener
    handleResult: function FeedFetcher_handleResult(aResult) {
        if (!aResult || !aResult.doc) {
            this.finish(false);
            return;
        }

        var feed = aResult.doc.QueryInterface(Ci.nsIFeed);

        this.downloadedFeed = Cc['@ancestor/brief/feed;1'].createInstance(Ci.nsIBriefFeed);
        this.downloadedFeed.wrapFeed(feed);

        // The URI that we passed and aResult.uri (which is actual URI from which the data
        // was fetched) may differ because of redirects. We want to use the former one
        // here, because that's the one which is stored in the Live Bookmark.
        this.downloadedFeed.feedURL = this.feed.feedURL;
        this.downloadedFeed.feedID = this.feed.feedID;

        // Now that we have the feed we can download the favicon if necessary. We
        // couldn't download it earlier, because we may have had no websiteURL.
        // We must use websiteURL instead of feedURL for resolving the favicon URL,
        // because many websites use services like Feedburner for generating their
        // feeds and we'd get the Feedburner's favicon instead of the website's
        // favicon.
        if (!this.favicon) {
            if (!this.downloadedFeed.websiteURL) {
                this.favicon = 'no-favicon';
                this.passDataToStorage();
                return;
            }

            var uri = Cc['@mozilla.org/network/io-service;1'].
                      getService(Ci.nsIIOService).
                      newURI(this.downloadedFeed.websiteURL, null, null);
            new FaviconFetcher(uri, this);
        }
        else {
            // If we already have the favicon, we're ready to commit the data
            this.passDataToStorage();
        }
    },


    passDataToStorage: function FeedFetcher_passDataToStorage() {
        this.finish(true);

        this.downloadedFeed.favicon = this.favicon;
        var storageService = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
        storageService.updateFeed(this.downloadedFeed);
    },


    finish: function FeedFetcher_finish(aOK) {
        // For whatever reason, if nsIFeedProcessor gets a parsing error it sometimes
        // calls handleResult() twice. We check the inError flag to avoid doing finish()
        // again, because it would seriously mess up the batch update by adding the
        // feed to the completedFeeds stack twice.
        if (this.inError)
            return;

        // We can't push the feed to the |completedFeeds| stack in brief:feed-updated
        // observer in the main class, because we have to ensure this is done before any
        // other observers receives this notification. Otherwise the progressmeters won't
        // be refreshed properly, because of outdated count of completed feeds.
        gBriefUpdateService.completedFeeds.push(this.feed);

        if (!aOK) {
            this.inError = true;
            this.observerService.notifyObservers(null, 'brief:feed-error', this.feed.feedID);
        }

        // Clean up, so that we don't leak (hopefully).
        this.observerService.removeObserver(this, 'brief:feed-update-canceled');
        this.request = null;
        this.timeoutTimer.cancel();
        this.timeoutTimer = null;
    },

    observe: function FeedFetcher_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
        case 'timer-callback':
            this.request.abort();
            this.finish(false);
            break;

        case 'brief:feed-update-canceled':
            this.request.abort();
            this.finish(true);
            break;
        }
    },

    QueryInterface: function FeedFetcher_QueryInterface(aIID) {
        if (aIID.equals(Ci.nsISupports) ||
           aIID.equals(Ci.nsIObserver) ||
           aIID.equals(Ci.nsIFeedResultListener))
            return this;
        throw Cr.NS_ERROR_NO_INTERFACE;
    }

}


/**
 * Downloads a favicon of a webpage and b64-encodes it.
 *
 * @param aWebsiteURI  URI of webpage which favicon to download (not URI of the
 *                     favicon itself).
 * @param aFeedFetcher FeedFetcher to use for callback.
 */
function FaviconFetcher(aWebsiteURI, aFeedFetcher) {
    var ios = Cc['@mozilla.org/network/io-service;1'].
              getService(Ci.nsIIOService);
    var faviconURI = ios.newURI(aWebsiteURI.prePath + '/favicon.ico', null, null);

    var chan = ios.newChannelFromURI(faviconURI);
    chan.notificationCallbacks = this;
    chan.asyncOpen(this, null);

    this.feedFetcher = aFeedFetcher;
    this.websiteURI = aWebsiteURI;
    this._channel = chan;
    this._bytes = [];
}

FaviconFetcher.prototype = {
    _channel:   null,
    _countRead: 0,
    _stream:    null,

    QueryInterface: function FaviconFetcher_loadQI(aIID) {
        if (aIID.equals(Ci.nsISupports)           ||
            aIID.equals(Ci.nsIRequestObserver)    ||
            aIID.equals(Ci.nsIStreamListener)     ||
            aIID.equals(Ci.nsIChannelEventSink)   ||
            aIID.equals(Ci.nsIInterfaceRequestor) ||
            aIID.equals(Ci.nsIBadCertListener)    ||
            // See bug 358878 comment 11
            aIID.equals(Ci.nsIPrompt)             ||
            // See FIXME comment below
            aIID.equals(Ci.nsIHttpEventSink)      ||
            aIID.equals(Ci.nsIProgressEventSink)  ||
            false) {
            return this;
        }

        throw Cr.NS_ERROR_NO_INTERFACE;
    },

    // nsIRequestObserver
    onStartRequest: function FaviconFetcher_loadStartR(aRequest, aContext) {
        this._stream = Cc["@mozilla.org/binaryinputstream;1"].
                       createInstance(Ci.nsIBinaryInputStream);
    },

    onStopRequest: function FaviconFetcher_loadStopR(aRequest, aContext, aStatusCode) {
        var requestFailed = !Components.isSuccessCode(aStatusCode);
        if (!requestFailed && (aRequest instanceof Ci.nsIHttpChannel))
            requestFailed = !aRequest.requestSucceeded;

        if (!requestFailed && this._countRead != 0) {
            var dataURI = ICON_DATAURL_PREFIX + this._b64(this._bytes);
            this.feedFetcher.favicon = dataURI;
            this.feedFetcher.passDataToStorage();
        }
        else {
            this.feedFetcher.favicon = 'no-favicon';
            this.feedFetcher.passDataToStorage();
        }

        this._channel = null;
        this._element  = null;
    },

    // nsIStreamListener
    onDataAvailable: function FaviconFetcher_onDataAvailable(aRequest, aContext,
                                                             aInputStream, aOffset, aCount) {
        this._stream.setInputStream(aInputStream);

        // Get a byte array of the data
        this._bytes = this._bytes.concat(this._stream.readByteArray(aCount));
        this._countRead += aCount;
    },

    // nsIChannelEventSink
    onChannelRedirect: function FaviconFetcher_onChannelRedirect(aOldChannel, aNewChannel,
                                                                 aFlags) {
        this._channel = aNewChannel;
    },

    // nsIInterfaceRequestor
    getInterface: function(aIID) {
        return this.QueryInterface(aIID);
    },

    // nsIBadCertListener
    confirmUnknownIssuer: function(aSocketInfo, aCert, aCertAddType) {
        return false;
    },

    confirmMismatchDomain: function(aSocketInfo, aTargetURL, aCert) {
        return false;
    },

    confirmCertExpired: function(aSocketInfo, aCert) {
        return false;
    },

    notifyCrlNextupdate: function(aSocketInfo, aTargetURL, aCert) {
    },

    // FIXME: bug 253127
    // nsIHttpEventSink
    onRedirect: function(aChannel, aNewChannel) { },
    // nsIProgressEventSink
    onProgress: function(aRequest, aContext, aProgress, aProgressMax) { },
    onStatus: function(aRequest, aContext, aStatus, aStatusArg) { },

    // copied over from nsSearchService.js
    _b64: function FaviconFetcher_b64(aBytes) {
        const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

        var index = 0;
        function get3Bytes() {
            if (aBytes.length - index < 3)
                return null; // Less than three bytes remaining

            // Return the next three bytes in the array, and increment index for our
            // next invocation
            return aBytes.slice(index, index += 3);
        }

        var out = "";
        var bytes = null;
        while ((bytes = get3Bytes())) {
            var bits = 0;
            for (var i = 0; i < 3; i++) {
                bits <<= 8;
                bits |= bytes[i];
            }
            for (var j = 18; j >= 0; j -= 6)
                out += B64_CHARS[(bits>>j) & 0x3F];
        }

        // Get the remaining bytes
        bytes = aBytes.slice(index);

        switch (bytes.length) {
            case 2:
                out += B64_CHARS[(bytes[0]>>2) & 0x3F] +
                       B64_CHARS[((bytes[0] & 0x03) << 4) | ((bytes[1] >> 4) & 0x0F)] +
                       B64_CHARS[((bytes[1] & 0x0F) << 2)] +
                       "=";
                break;

            case 1:
                out += B64_CHARS[(bytes[0]>>2) & 0x3F] +
                       B64_CHARS[(bytes[0] & 0x03) << 4] +
                       "==";
                break;
        }

        return out;
    }

}


var Factory = {

    createInstance: function (aOuter, aIID) {
        if (aOuter != null)
            throw Components.results.NS_ERROR_NO_AGGREGATION;
        if (gBriefUpdateService === null)
            gBriefUpdateService = new BriefUpdateService();
        return gBriefUpdateService.QueryInterface(aIID);
    }
}

// Module definition (xpcom registration)
var Module = {
    _firstTime: true,

    registerSelf: function(aCompMgr, aFileSpec, aLocation, aType) {
        aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
        aCompMgr.registerFactoryLocation(CLASS_ID, CLASS_NAME, CONTRACT_ID,
                                         aFileSpec, aLocation, aType);

        var categoryManager = Components.classes['@mozilla.org/categorymanager;1'].
                              getService(Components.interfaces.nsICategoryManager);
        categoryManager.addCategoryEntry('app-startup', 'nsIBriefUpdateService',
                                         CONTRACT_ID, true, true);
    },

    unregisterSelf: function(aCompMgr, aLocation, aType) {
        aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
        aCompMgr.unregisterFactoryLocation(CLASS_ID, aLocation);

        var categoryManager = Components.classes['@mozilla.org/categorymanager;1'].
                              getService(Components.interfaces.nsICategoryManager);
        categoryManager.deleteCategoryEntry('app-startup', 'nsIBriefUpdateService', true);
    },

    getClassObject: function(aCompMgr, aCID, aIID) {
        if (!aIID.equals(Components.interfaces.nsIFactory))
            throw Components.results.NS_ERROR_NOT_IMPLEMENTED;

        if (aCID.equals(CLASS_ID))
            return Factory;

        throw Components.results.NS_ERROR_NO_INTERFACE;
    },

    canUnload: function(aCompMgr) { return true; }

}

// Module initialization
function NSGetModule(aCompMgr, aFileSpec) { return Module; }