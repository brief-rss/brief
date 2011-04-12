const EXPORTED_SYMBOLS = ['FeedUpdateService'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/FeedContainer.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

IMPORT_COMMON(this);

// Can't use the Cc shorthand imported from common.jsm here. Components object
// is different in each scope and because of this, testing equality of instances
// of XPCOM objects may bizzarely return false.
// Namely, couldn't check aTimer in nsITimerCallback.notify().
const Cc = Components.classes;
const Ci = Components.interfaces;


const UPDATE_TIMER_INTERVAL = 60000; // 1 minute
const FEED_FETCHER_TIMEOUT = 25000; // 25 seconds
const FAVICON_REFRESH_INTERVAL = 14*24*60*60*1000; // 2 weeks

const FEED_ICON_URL = 'chrome://brief/skin/icon.png';

const TIMER_TYPE_ONE_SHOT = Ci.nsITimer.TYPE_ONE_SHOT;
const TIMER_TYPE_PRECISE  = Ci.nsITimer.TYPE_REPEATING_PRECISE;
const TIMER_TYPE_SLACK    = Ci.nsITimer.TYPE_REPEATING_SLACK;


XPCOMUtils.defineLazyGetter(this, 'Prefs', function() {
    return Services.prefs.getBranch('extensions.brief.').QueryInterface(Ci.nsIPrefBranch2);
})
XPCOMUtils.defineLazyGetter(this, 'Storage', function() {
    let tempScope = {};
    Components.utils.import('resource://brief/Storage.jsm', tempScope);
    return tempScope.Storage;
})


// Exported object exposing public properties.
const FeedUpdateService = Object.freeze({

    /**
     * Indicates if updating is in progress.
     */
    NOT_UPDATING: 0,
    BACKGROUND_UPDATING: 1,
    NORMAL_UPDATING: 2,

    get status() {
        return FeedUpdateServiceInternal.status;
    },

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
})


let FeedUpdateServiceInternal = {

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
        Services.obs.addObserver(this, 'brief:feed-updated', false);
        Services.obs.addObserver(this, 'quit-application', false);
        Prefs.addObserver('', this, false);

        XPCOMUtils.defineLazyGetter(this, 'updateTimer', function() {
            return Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        })

        XPCOMUtils.defineLazyGetter(this, 'fetchDelayTimer', function() {
            return Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        })

        // Delay the initial autoupdate check in order not to slow down the startup.
        this.startupDelayTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        let startupDelay = Prefs.getIntPref('update.startupDelay');
        this.startupDelayTimer.initWithCallback(this, startupDelay, TIMER_TYPE_ONE_SHOT);
    },

    // See FeedUpdateService.
    updateAllFeeds: function FeedUpdateServiceInternal_updateAllFeeds(aInBackground) {
        this.updateFeeds(Storage.getAllFeeds(), aInBackground);
    },

    // See FeedUpdateService.
    updateFeeds: function FeedUpdateServiceInternal_updateFeeds(aFeeds, aInBackground) {
        // Don't add the same feed be added twice.
        let newFeeds = aFeeds.filter(function(f) this.updateQueue.indexOf(f) == -1, this);

        this.scheduledFeeds = this.scheduledFeeds.concat(newFeeds);
        this.updateQueue = this.updateQueue.concat(newFeeds);

        if (Storage.getAllFeeds().every(function(f) this.scheduledFeeds.indexOf(f) != -1, this))
            Prefs.setIntPref('update.lastUpdateTime', Math.round(Date.now() / 1000));

        // Start an update if it isn't in progress yet.
        if (this.status == this.NOT_UPDATING) {
            let delay = aInBackground ? Prefs.getIntPref('update.backgroundFetchDelay')
                                      : Prefs.getIntPref('update.defaultFetchDelay');

            this.fetchDelayTimer.initWithCallback(this, delay, TIMER_TYPE_SLACK);
            this.status = aInBackground ? this.BACKGROUND_UPDATING : this.NORMAL_UPDATING;

            this.fetchNextFeed();
        }
        else if (this.status == this.BACKGROUND_UPDATING && !aInBackground) {
            // Stop the background update and continue with a foreground one.
            this.fetchDelayTimer.cancel();

            let delay = Prefs.getIntPref('update.defaultFetchDelay');
            this.fetchDelayTimer.initWithCallback(this, delay, TIMER_TYPE_SLACK);
            this.status = this.NORMAL_UPDATING;

            this.fetchNextFeed();
        }

        if (newFeeds.length)
            Services.obs.notifyObservers(null, 'brief:feed-update-queued', '');
    },

    // See FeedUpdateService.
    stopUpdating: function FeedUpdateServiceInternal_stopUpdating() {
        if (this.status != this.NOT_UPDATING)
            this.finishUpdate('cancelled');
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

            let globalUpdatingEnabled = Prefs.getBoolPref('update.enableAutoUpdate');
            // Preferencos are in seconds, because they can only store 32 bit integers.
            let globalInterval = Prefs.getIntPref('update.interval') * 1000;
            let lastGlobalUpdateTime = Prefs.getIntPref('update.lastUpdateTime') * 1000;
            let now = Date.now();

            let itsGlobalUpdateTime = globalUpdatingEnabled &&
                                      now - lastGlobalUpdateTime > globalInterval;

            // Filter feeds which need to be updated, according to either the global
            // update interval or their own feed-specific interval.
            function filter(f) (f.updateInterval == 0 && itsGlobalUpdateTime) ||
                               (f.updateInterval > 0 && now - f.lastUpdated > f.updateInterval);
            let feedsToUpdate = Storage.getAllFeeds().filter(filter);

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
        let feed = this.updateQueue.shift();
        if (feed)
            new FeedFetcher(feed);
    },


    onFeedUpdated: function FeedUpdateServiceInternal_onFeedUpdated(aFeed, aResult, aNewEntriesCount) {
        this.completedFeeds.push(aFeed);
        this.newEntriesCount += aNewEntriesCount;
        if (aNewEntriesCount > 0)
            this.feedsWithNewEntriesCount++;

        Services.obs.notifyObservers(null, 'brief:feed-updated', aFeed.feedID);
        if (aResult == 'error')
            Services.obs.notifyObservers(null, 'brief:feed-error', aFeed.feedID);

        if (this.completedFeeds.length == this.scheduledFeeds.length)
            this.finishUpdate('completed');
    },


    finishUpdate: function FeedUpdateServiceInternal_finishUpdate(aReason) {
        this.status = this.NOT_UPDATING;
        this.fetchDelayTimer.cancel();

        let showNotification = Prefs.getBoolPref('update.showNotification');
        if (this.feedsWithNewEntriesCount > 0 && showNotification) {
            let bundle = Services.strings.createBundle('chrome://brief/locale/brief.properties');
            let alertTitle = bundle.GetStringFromName('updateAlertTitle');

            let feedForms = bundle.GetStringFromName('feeds');
            let feedString = getPluralForm(this.feedsWithNewEntriesCount, feedForms);
            let itemForms = bundle.GetStringFromName('items');
            let itemString = getPluralForm(this.newEntriesCount, itemForms);
            let alertText;

            if (this.feedsWithNewEntriesCount == 1) {
                let feedTitle = this.completedFeeds[0].title;
                feedTitle = feedTitle.length < 30 ? feedTitle : feedTitle.substr(0, 30) + '\u2026';

                alertText = bundle.formatStringFromName('updateAlertText.singleFeed', [itemString, feedTitle], 2)
                                  .replace('#numItems', this.newEntriesCount);
            }
            else {
                alertText = bundle.formatStringFromName('updateAlertText.manyFeeds', [itemString, feedString], 2)
                                  .replace('#numItems', this.newEntriesCount)
                                  .replace('#numFeeds', this.feedsWithNewEntriesCount);
            }

            try {
                let alertsService = Cc['@mozilla.org/alerts-service;1']
                                    .getService(Ci.nsIAlertsService);
                alertsService.showAlertNotification(FEED_ICON_URL, alertTitle, alertText,
                                                    true, null, this);
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

        Services.obs.notifyObservers(null, 'brief:feed-update-finished', aReason);
    },


    // nsIObserver
    observe: function FeedUpdateServiceInternal_observe(aSubject, aTopic, aData) {
        switch (aTopic) {

        // Notification from nsIAlertsService that user has clicked the link in
        // the alert.
        case 'alertclickcallback':
            let window = Services.wm.getMostRecentWindow('navigator:browser');
            if (window) {
                window.Brief.open();
                window.focus();
            }
            break;

        case 'nsPref:changed':
            if (aData == 'update.enableAutoUpdate' || aData == 'update.interval')
                this.notify(this.updateTimer);
            break;

        case 'quit-application':
            Services.obs.removeObserver(this, 'brief:feed-updated');
            Services.obs.removeObserver(this, 'quit-application');
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

    Services.obs.notifyObservers(null, 'brief:feed-loading', this.feed.feedID);
    Services.obs.addObserver(this, 'brief:feed-update-finished', false);

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

    finished: false,


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

        let self = this;

        function onRequestError() {
            // See /extensions/venkman/resources/content/venkman-jsdurl.js#983 et al.
            const I_LOVE_NECKO_TOO = 2152398850;

            if (self.request.channel.status == I_LOVE_NECKO_TOO) {
                self.request.abort();
                self.requestFeed();
            }
            else {
                self.finish('error');
            }
        }

        function onRequestLoad() {
            self.timeoutTimer.cancel();
            try {
                let uri = Services.io.newURI(self.feed.feedURL, null, null);
                self.parser.parseFromString(self.request.responseText, uri);
            }
            catch (ex) {
                self.finish('error');
            }
        }
    },

    // nsIFeedResultListener
    handleResult: function FeedFetcher_handleResult(aResult) {
        // Prevent handleResult from being called twice, which seems to
        // sometimes happen with parsing errors.
        this.parser.listener = null;

        if (!aResult || !aResult.doc) {
            this.finish('error');
            return;
        }

        this.bozo = aResult.bozo;

        let downloadedFeed = aResult.doc.QueryInterface(Ci.nsIFeed);

        if (downloadedFeed.link)
            this.feed.websiteURL = downloadedFeed.link.spec;
        if (downloadedFeed.subtitle)
            this.feed.subtitle = downloadedFeed.subtitle.text;

        this.feed.wrappedFeed = downloadedFeed;

        entries = [];
        if (downloadedFeed.items) {
            // Counting down, because the order of items is reversed after parsing.
            for (let i = downloadedFeed.items.length - 1; i >= 0; i--) {
                let entry = downloadedFeed.items.queryElementAt(i, Ci.nsIFeedEntry);
                entries.push(new Entry(entry));
            }
        }

        let timeSinceRefresh = Date.now() - this.feed.lastFaviconRefresh;
        if (!this.feed.favicon || timeSinceRefresh > FAVICON_REFRESH_INTERVAL)
            new FaviconFetcher(this.feed)

        Storage.processFeed(this.feed, entries, function(aNewEntriesCount) {
            this.finish('ok', aNewEntriesCount);
        }.bind(this));
    },

    finish: function FeedFetcher_finish(aResult, aNewEntriesCount) {
        if (this.finished)
            return;

        if (aResult == 'ok' || aResult == 'error')
            FeedUpdateServiceInternal.onFeedUpdated(this.feed, aResult, aNewEntriesCount || 0);

        Services.obs.removeObserver(this, 'brief:feed-update-finished');
        this.request = null;
        this.timeoutTimer.cancel();
        this.timeoutTimer = null;
        this.parser.listener = null;

        this.finished = true;
    },

    observe: function FeedFetcher_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
            case 'timer-callback':
                this.request.abort();
                this.finish('error');
                break;

            case 'brief:feed-update-finished':
                if (aData == 'cancelled') {
                    this.request.abort();
                    this.finish('cancelled');
                }
                break;
            }
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver, Ci.nsIFeedResultListener])

}

/**
 * Downloads a favicon for a feed and base64-encodes it.
 *
 * @param aFeed
 *        Feed object of the feed whose favicon to download.
 */
function FaviconFetcher(aFeed) {
    this.feed = aFeed;

    if (!aFeed.websiteURL) {
        this.finish('no-favicon');
        return;
    }

    // Use websiteURL instead of feedURL for resolving the favicon URL,
    // because many websites use services like Feedburner for generating their
    // feeds and we would get the Feedburner's favicon instead.
    let websiteURI = Services.io.newURI(aFeed.websiteURL, null, null)
    let faviconURI = Services.io.newURI(websiteURI.prePath + '/favicon.ico', null, null);

    let chan = Services.io.newChannelFromURI(faviconURI);
    chan.notificationCallbacks = this;
    chan.asyncOpen(this, null);

    this.websiteURI = websiteURI;
    this._channel = chan;
    this._bytes = [];
}

FaviconFetcher.prototype = {

    websiteURI:  null,

    _channel:   null,
    _countRead: 0,
    _stream:    null,

    finish: function FaviconFetcher_finish(aFaviconString) {
        this.feed.lastFaviconRefresh = Date.now();

        if (this.feed.favicon != aFaviconString) {
            this.feed.favicon = aFaviconString;
            Storage.updateFeedProperties(this.feed);
            Services.obs.notifyObservers(null, 'brief:feed-favicon-changed', this.feed.feedID);
        }
    },

    // nsIRequestObserver
    onStartRequest: function FaviconFetcher_lonStartRequest(aRequest, aContext) {
        this._stream = Cc['@mozilla.org/binaryinputstream;1']
                       .createInstance(Ci.nsIBinaryInputStream);
    },

    onStopRequest: function FaviconFetcher_onStopRequest(aRequest, aContext, aStatusCode) {
        let requestFailed = !Components.isSuccessCode(aStatusCode);
        if (!requestFailed && (aRequest instanceof Ci.nsIHttpChannel))
            requestFailed = !aRequest.requestSucceeded;

        if (!requestFailed && this._countRead != 0) {
            let base64DataString =  btoa(String.fromCharCode.apply(null, this._bytes))
            this.finish('data:image/x-icon;base64,' + base64DataString);
        }
        else {
            this.finish('no-favicon');
        }

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


FeedUpdateServiceInternal.init();
