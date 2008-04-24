const CLASS_ID    = Components.ID('{13A031E4-7EE9-11DB-8E2E-A58155D89593}');
const CLASS_NAME  = 'Feed updating service for the Brief extension';
const CONTRACT_ID = '@ancestor/brief/updateservice;1';

const Cc = Components.classes;
const Ci = Components.interfaces;

const TIMER_TYPE_ONE_SHOT = Ci.nsITimer.TYPE_ONE_SHOT;
const TIMER_TYPE_PRECISE  = Ci.nsITimer.TYPE_REPEATING_PRECISE;
const TIMER_TYPE_SLACK    = Ci.nsITimer.TYPE_REPEATING_SLACK;

const ICON_DATAURL_PREFIX = 'data:image/x-icon;base64,';
const FEED_ICON_URL       = 'chrome://brief/skin/icon.png';

const UPDATE_TIMER_INTERVAL = 120000; // 2 minutes
const STARTUP_DELAY = 20000; // 20 seconds
const FEED_FETCHER_TIMEOUT = 25000; // 25 seconds

const NOT_UPDATING = Ci.nsIBriefUpdateService.NOT_UPDATING;
const NORMAL_UPDATING = Ci.nsIBriefUpdateService.NORMAL_UPDATING;
const BACKGROUND_UPDATING = Ci.nsIBriefUpdateService.BACKGROUND_UPDATING;


Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

__defineGetter__('gObserverService', function() {
    delete this.gObserverService;
    return this.gObserverService = Cc['@mozilla.org/observer-service;1'].
                                   getService(Ci.nsIObserverService);
});
__defineGetter__('gPrefs', function() {
    delete this.gPrefs;
    return this.gPrefs = Cc['@mozilla.org/preferences-service;1'].
                         getService(Ci.nsIPrefService).
                         getBranch('extensions.brief.').
                         QueryInterface(Ci.nsIPrefBranch2);
});
__defineGetter__('gIOService', function() {
    delete this.gIOService;
    return this.gIOService = Cc['@mozilla.org/network/io-service;1'].
                             getService(Ci.nsIIOService);
});
__defineGetter__('gStorage', function() {
    delete this.gStorage;
    return this.gStorage = Cc['@ancestor/brief/storage;1'].
                           getService(Ci.nsIBriefStorage);
});


gUpdateService = null;

// Class definition
function BriefUpdateService() {
    gObserverService.addObserver(this, 'brief:feed-updated', false);
    gObserverService.addObserver(this, 'brief:feed-error', false);
    gObserverService.addObserver(this, 'profile-after-change', false);
}

BriefUpdateService.prototype = {

    // nsIBriefUpdateService
    get scheduledFeedsCount BUS_scheduledFeedsCount() {
        return this.scheduledFeeds.length;
    },

    // nsIBriefUpdateService
    get completedFeedsCount BUS_completedFeedsCount() {
        return this.completedFeeds.length;
    },

    // nsIBriefUpdateService
    status: NOT_UPDATING,

    scheduledFeeds: [],  // feeds to be updated in the current job (array of nsIBriefFeed's)
    updateQueue:    [],  // remaining feeds to be fetched
    completedFeeds: [],  // feeds that have already been fetched and parsed

    feedsWithNewEntriesCount: 0,  // number of feeds updated in the current batch that have new entries
    newEntriesCount:          0,  // total number of new entries in the current batch


    get updateTimer BUS_updateTimer()
        this.__updateTimer || (this.__updateTimer = Cc['@mozilla.org/timer;1'].
                                                    createInstance(Ci.nsITimer)),

    get startupDelayTimer BUS_startupDelayTimer()
        this.__startupDelayTimer || (this.__startupDelayTimer = Cc['@mozilla.org/timer;1'].
                                                                createInstance(Ci.nsITimer)),

    get fetchDelayTimer BUS_fetchDelayTimer()
        this.__fetchDelayTimer || (this.__fetchDelayTimer = Cc['@mozilla.org/timer;1'].
                                                            createInstance(Ci.nsITimer)),


    // nsIBriefUpdateService
    fetchAllFeeds: function BUS_fetchAllFeeds(aInBackground) {
        this.fetchFeeds(gStorage.getAllFeeds(), aInBackground);

        var roundedNow = Math.round(Date.now() / 1000);
        gPrefs.setIntPref('update.lastUpdateTime', roundedNow);
    },


    // nsIBriefUpdateService
    fetchFeeds: function BUS_fetchFeeds(aFeeds, aInBackground) {
        // Add feeds to the queue, but don't let the same feed be added twice.
        var newFeedsQueued = false;
        for each (feed in aFeeds) {
            if (this.updateQueue.indexOf(feed) == -1) {
                this.scheduledFeeds.push(feed);
                this.updateQueue.push(feed);
                newFeedsQueued = true;
            }
        }

        // Start updating if it isn't in progress yet. We will fetch feeds on an interval,
        // so we don't choke when downloading and processing all of them a once.
        if (this.status == NOT_UPDATING) {
            var delay = aInBackground ? gPrefs.getIntPref('update.backgroundFetchDelay')
                                      : gPrefs.getIntPref('update.defaultFetchDelay');
            this.fetchDelayTimer.initWithCallback(this, delay, TIMER_TYPE_SLACK);
        }

        // If background update is in progress and foreground update is attempted,
        // we stop the background start continue with a foreground one.
        if (this.status == BACKGROUND_UPDATING && !aInBackground) {
            this.fetchDelayTimer.cancel();
            var delay = gPrefs.getIntPref('update.defaultFetchDelay');
            this.fetchDelayTimer.initWithCallback(this, delay, TIMER_TYPE_SLACK);
        }

        if (this.status != NORMAL_UPDATING) {
            this.status = aInBackground ? BACKGROUND_UPDATING
                                        : NORMAL_UPDATING;
        }

        // If new feeds have ended up in the queue then send the notification.
        if (newFeedsQueued)
            gObserverService.notifyObservers(null, 'brief:feed-update-queued', '');
    },


    stopFetching: function BUS_stopFetching() {
        gObserverService.notifyObservers(null, 'brief:feed-update-canceled', '');

        // We must call this after sending brief:feed-update-canceled, because when a
        // feed fetcher receives it, it adds a feed to the completedFeeds stack. If we
        // called finishUpdate before that, the completedStack wouldn't be cleaned,
        // thus messing up subsequent updates.
        this.finishUpdate();
    },


    // nsITimerCallback
    notify: function BUS_notify(aTimer) {
        switch (aTimer) {

        case this.startupDelayTimer:
            this.updateTimer.initWithCallback(this, UPDATE_TIMER_INTERVAL, TIMER_TYPE_SLACK);
            // Fall through...

        case this.updateTimer:
            var globalUpdatingEnabled = gPrefs.getBoolPref('update.enableAutoUpdate');
            // Preferencos are in seconds, because they can only store 32 bit integers.
            var globalInterval = gPrefs.getIntPref('update.interval') * 1000;
            var lastGlobalUpdateTime = gPrefs.getIntPref('update.lastUpdateTime') * 1000;
            var now = Date.now();

            var itsGlobalUpdateTime = globalUpdatingEnabled &&
                                      now - lastGlobalUpdateTime > globalInterval;

            var feeds = gStorage.getAllFeeds();

            var feed, i, feedsToUpdate = [];
            for (i = 0; i < feeds.length; i++) {
                feed = feeds[i];
                if ((feed.updateInterval > 0 && now - feed.lastUpdated > feed.updateInterval)
                    || (feed.updateInterval == 0 && itsGlobalUpdateTime))
                    feedsToUpdate.push(feed);
            }

            if (feedsToUpdate.length)
                this.fetchFeeds(feedsToUpdate, feedsToUpdate.length, true);

            if (itsGlobalUpdateTime) {
                // Preferences can only store 32 bit integers, so round to seconds.
                var roundedNow = Math.round(now / 1000);
                gPrefs.setIntPref('update.lastUpdateTime', roundedNow);
            }

            break;

        case this.fetchDelayTimer:
            var feed = this.updateQueue.shift();

            // All feeds in the update queue may have already been requested,
            // because we don't cancel the timer until after all feeds are completed.
            if (feed)
                new FeedFetcher(feed, this);

            break;
        }
    },


    finishUpdate: function BUS_finishUpdate() {
        this.status = NOT_UPDATING;
        this.fetchDelayTimer.cancel();

        var showNotification = gPrefs.getBoolPref('update.showNotification');
        if (this.feedsWithNewEntriesCount > 0 && showNotification) {

            var bundle = Cc['@mozilla.org/intl/stringbundle;1'].
                         getService(Ci.nsIStringBundleService).
                         createBundle('chrome://brief/locale/brief.properties');
            var title = bundle.GetStringFromName('feedsUpdatedAlertTitle');
            var params = [this.newEntriesCount, this.feedsWithNewEntriesCount];
            var text = bundle.formatStringFromName('updateAlertText', params, 2);

            try {
                var alertsService = Cc['@mozilla.org/alerts-service;1'].
                                    getService(Ci.nsIAlertsService);
                alertsService.showAlertNotification(FEED_ICON_URL, title, text,
                                                    true, null, this);
            }
            catch (ex) {
                // XXX There are some reports of nsIAlertsService failing on OS X with
                // Growl installed. Let's catch the exception until a real solution
                // is found.
                Components.utils.reportError(ex);
            }
        }

        // Reset the properties after updating is finished.
        this.newEntriesCount = this.feedsWithNewEntriesCount = 0;
        this.completedFeeds = [];
        this.scheduledFeeds = [];
        this.updateQueue = [];
    },


    // nsIObserver
    observe: function BUS_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

        // Startup initialization. We use this instead of app-startup,
        // so that the preferences are already initialized.
        case 'profile-after-change':
            if (aData == 'startup') {
                // Delay enabling autoupdate, so not to slow down the startup. Plus,
                // nsIBriefStorage is instantiated on profile-after-change.
                this.startupDelayTimer.initWithCallback(this, STARTUP_DELAY,
                                                        TIMER_TYPE_ONE_SHOT);

                // We add the observer here instead of in the constructor as prefs
                // are changed during startup when assuming their user-set values.
                gPrefs.addObserver('', this, false);
            }
            break;

        case 'brief:feed-error':
        case 'brief:feed-updated':
            // Count updated feeds, so we can show their number in
            // the alert when updating is completed.
            if (aSubject && aSubject.QueryInterface(Ci.nsIVariant) > 0) {
                this.newEntriesCount += aSubject.QueryInterface(Ci.nsIVariant);
                this.feedsWithNewEntriesCount++;
            }

            if (this.completedFeeds.length == this.scheduledFeeds.length)
                this.finishUpdate();
            break;

        // Notification from nsIAlertsService that user has clicked the link in
        // the alert.
        case 'alertclickcallback':
            var window = Cc['@mozilla.org/appshell/window-mediator;1'].
                         getService(Ci.nsIWindowMediator).
                         getMostRecentWindow('navigator:browser');
            if (window) {
                window.gBrief.open(true);
                window.focus();
            }
            break;

        case 'nsPref:changed':
            switch (aData) {

            // Force checking if we should update when the prefs are changed,
            // so that the effects are visible immediately.
            case 'update.enableAutoUpdate':
            case 'update.interval':
                this.notify(this.updateTimer);
                break;
            }
            break;
        }
    },

    classDescription: CLASS_NAME,
    classID: CLASS_ID,
    contractID: CONTRACT_ID,
    _xpcom_categories: [ { category: 'app-startup', service: true } ],
    _xpcom_factory: {
        createInstance: function(aOuter, aIID) {
            if (aOuter != null)
                throw Components.results.NS_ERROR_NO_AGGREGATION;

            if (!gUpdateService)
                gUpdateService = new BriefUpdateService();

            return gUpdateService.QueryInterface(aIID);
        }
    },
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIBriefUpdateService,
                                           Ci.nsITimerCallback,
                                           Ci.nsIObserver])
}


/**
 * This object downloads the feed, parses it and updates the database.
 *
 * @param aFeed nsIFeed object representing the feed to be downloaded.
 */
function FeedFetcher(aFeed) {
    this.feed = aFeed;

    gObserverService.notifyObservers(null, 'brief:feed-loading', this.feed.feedID);
    gObserverService.addObserver(this, 'brief:feed-update-canceled', false);

    this.timeoutTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);

    this.favicon = this.feed.favicon;

    this.requestFeed();
}

FeedFetcher.prototype = {

    feed:           null, // The passed feed, as currently stored in the database.
    downloadedFeed: null, // The downloaded feed. Initially null.

    request:      null,
    timeoutTimer: null,

    // Indicates if the request has encountered an error (either a connection error or
    // parsing error) and has sent 'brief:feed-error' notification.
    inError: false,

    requestFeed: function FeedFetcher_requestFeed() {
        var self = this;

        // See /extensions/venkman/resources/content/venkman-jsdurl.js#983 et al.
        const I_LOVE_NECKO_TOO = 2152398850;

        function onRequestError() {
            if (self.request.channel.status == I_LOVE_NECKO_TOO) {
                self.request.abort();
                self.requestFeed();
            }
            else {
                self.finish(false);
            }
        }

        function onRequestLoad() {
            self.timeoutTimer.cancel();

            var uri = gIOService.newURI(self.feed.feedURL, null, null);
            var parser = Cc['@mozilla.org/feed-processor;1'].
                         createInstance(Ci.nsIFeedProcessor);
            parser.listener = self;

            try {
                parser.parseFromString(self.request.responseText, uri);
            }
            catch (ex) {
                self.finish(false);
            }
        }

        this.request = Cc['@mozilla.org/xmlextras/xmlhttprequest;1'].
                       createInstance(Ci.nsIXMLHttpRequest);
        this.request.mozBackgroundRequest = true;
        this.request.open('GET', this.feed.feedURL, true);
        this.request.overrideMimeType('application/xml');
        this.request.onload = onRequestLoad;
        this.request.onerror = onRequestError;
        this.request.send(null);

        this.timeoutTimer.init(this, FEED_FETCHER_TIMEOUT, TIMER_TYPE_ONE_SHOT);
    },


    // nsIFeedResultListener
    handleResult: function FeedFetcher_handleResult(aResult) {
        if (!aResult || !aResult.doc || aResult.bozo) {
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

        if (!this.favicon) {
            // We use websiteURL instead of feedURL for resolving the favicon URL,
            // because many websites use services like Feedburner for generating their
            // feeds and we'd get the Feedburner's favicon instead of the website's
            // favicon.
            if (this.downloadedFeed.websiteURL) {
                new FaviconFetcher(this.downloadedFeed.websiteURL, this);
            }
            else {
                this.favicon = 'no-favicon';
                this.passDataToStorage();
            }
        }
        else {
            this.passDataToStorage();
        }
    },


    onFaviconReady: function FeedFetcher_onFaviconReady(aFavicon) {
        this.favicon = aFavicon;
        this.passDataToStorage();
    },


    passDataToStorage: function FeedFetcher_passDataToStorage() {
        this.finish(true);

        this.downloadedFeed.favicon = this.favicon;
        gStorage.updateFeed(this.downloadedFeed);
    },


    finish: function FeedFetcher_finish(aSuccess) {
        // For whatever reason, if nsIFeedProcessor gets a parsing error it sometimes
        // calls handleResult() twice. We check the inError flag to avoid doing finish()
        // again, because it would seriously mess up the batch update by adding the
        // feed to the completedFeeds stack twice.
        if (this.inError)
            return;

        // We can't push the feed to the |completedFeeds| stack in brief:feed-updated
        // observer in the main class, because we have to ensure this is done before any
        // other observers receive this notification. Otherwise the progressmeters won't
        // be refreshed properly, because of outdated count of completed feeds.
        gUpdateService.completedFeeds.push(this.feed);

        if (!aSuccess) {
            this.inError = true;
            gObserverService.notifyObservers(null, 'brief:feed-error', this.feed.feedID);
        }

        // Clean up, so that we don't leak (hopefully).
        gObserverService.removeObserver(this, 'brief:feed-update-canceled');
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


    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver],
                                          [Ci.nsIFeedResultListener])

}

/**
 * Downloads a favicon of a webpage and base64-encodes it.
 *
 * @param aWebsiteURL  URL of webpage which favicon to download (not URI of the
 *                     favicon itself).
 * @param aFeedFetcher FeedFetcher to use for callback.
 */
function FaviconFetcher(aWebsiteURL, aFeedFetcher) {
    var websiteURI = gIOService.newURI(aWebsiteURL, null, null)
    var faviconURI = gIOService.newURI(websiteURI.prePath + '/favicon.ico', null, null);

    var chan = gIOService.newChannelFromURI(faviconURI);
    chan.notificationCallbacks = this;
    chan.asyncOpen(this, null);

    this.feedFetcher = aFeedFetcher;
    this.websiteURI = websiteURI;
    this._channel = chan;
    this._bytes = [];
}

FaviconFetcher.prototype = {
    feedFetcher: null,
    websiteURI:  null,

    _channel:   null,
    _countRead: 0,
    _stream:    null,

    // nsIRequestObserver
    onStartRequest: function FaviconFetcher_lonStartRequest(aRequest, aContext) {
        this._stream = Cc['@mozilla.org/binaryinputstream;1'].
                         createInstance(Ci.nsIBinaryInputStream);
    },

    onStopRequest: function FaviconFetcher_onStopRequest(aRequest, aContext, aStatusCode) {
        var requestFailed = !Components.isSuccessCode(aStatusCode);
        if (!requestFailed && (aRequest instanceof Ci.nsIHttpChannel))
            requestFailed = !aRequest.requestSucceeded;

        if (!requestFailed && this._countRead != 0) {
            var base64DataString =  btoa(String.fromCharCode.apply(null, this._bytes))
            var favicon = ICON_DATAURL_PREFIX + base64DataString;
        }
        else {
            favicon = 'no-favicon';
        }

        this.feedFetcher.onFaviconReady(favicon);

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
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage(aMessage);
}


function NSGetModule(compMgr, fileSpec) XPCOMUtils.generateModule([BriefUpdateService])
