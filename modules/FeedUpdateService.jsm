const EXPORTED_SYMBOLS = ['FeedUpdateService'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Storage.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import("resource://gre/modules/PromiseUtils.jsm");
Components.utils.import('resource://gre/modules/Task.jsm');

IMPORT_COMMON(this);

const UPDATE_TIMER_INTERVAL = 60000; // 1 minute
const FEED_FETCHER_TIMEOUT = 25000; // 25 seconds
const FAVICON_REFRESH_INTERVAL = 14*24*60*60*1000; // 2 weeks

const FEED_ICON_URL = 'chrome://brief/skin/brief-icon-32.png';
const TIMER_TYPE_SLACK = Ci.nsITimer.TYPE_REPEATING_SLACK;


XPCOMUtils.defineLazyGetter(this, 'Prefs', () => {
    return Services.prefs.getBranch('extensions.brief.');
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
    },

    /**
     * Downloads and parses the feed under the given URL and creates a
     * Live Bookmark for it in the home folder.
     *
     * @param aURL
     *        The feed's URL.
     */
    addFeed: function(aURL) {
        return FeedUpdateServiceInternal.addFeed(aURL);
    },

    /**
     * Initialize the feed update subsystem
     */
    init: function() {
        return FeedUpdateServiceInternal.init();
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

    // The latest feed with new entries
    latestChangedFeed: null,

    // Number of feeds updated in the current batch that have new entries
    feedsWithNewEntriesCount: 0,

    // Total number of new entries in the current batch
    newEntriesCount:          0,

    get fetchDelayTimer() {
        delete this.fetchDelayTimer;
        return this.fetchDelayTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
    },

    init: function* FeedUpdateServiceInternal_init() {
        Services.obs.addObserver(this, 'brief:feed-updated', false);
        Services.obs.addObserver(this, 'quit-application', false);

        // Delay the initial update to avoid slowing down the startup.
        yield wait(Prefs.getIntPref('update.startupDelay'));

        yield Storage.ready;

        // Pref observer can trigger an update so register it after the delay.
        Prefs.addObserver('', this, false);

        this.updateTimer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
        this.updateTimer.initWithCallback(this.updateTimerBeat.bind(this),
                                          UPDATE_TIMER_INTERVAL, TIMER_TYPE_SLACK);
        this.updateTimerBeat();
    }.task(),

    // See FeedUpdateService.
    updateAllFeeds: function* FeedUpdateServiceInternal_updateAllFeeds(aInBackground) {
        yield Storage.ready;
        this.updateFeeds(Storage.getAllFeeds(), aInBackground);
    }.task(),

    // See FeedUpdateService.
    updateFeeds: function* FeedUpdateServiceInternal_updateFeeds(aFeeds, aInBackground) {
        yield Storage.ready;

        // Don't add the same feed be added twice.
        let newFeeds = aFeeds.filter(feed => this.updateQueue.indexOf(feed) == -1);

        this.scheduledFeeds = this.scheduledFeeds.concat(newFeeds);
        this.updateQueue = this.updateQueue.concat(newFeeds);

        if (Storage.getAllFeeds().every(feed => this.scheduledFeeds.indexOf(feed) != -1))
            Prefs.setIntPref('update.lastUpdateTime', Math.round(Date.now() / 1000));

        // Start an update if it isn't in progress yet.
        if (this.status == this.NOT_UPDATING) {
            let delay = aInBackground ? Prefs.getIntPref('update.backgroundFetchDelay')
                                      : Prefs.getIntPref('update.defaultFetchDelay');
            this.fetchDelayTimer.initWithCallback(this.updateNextFeed.bind(this), delay,
                                                  TIMER_TYPE_SLACK);

            this.status = aInBackground ? this.BACKGROUND_UPDATING : this.NORMAL_UPDATING;

            this.updateNextFeed();
        }
        else if (this.status == this.BACKGROUND_UPDATING && !aInBackground) {
            // Stop the background update and continue with a foreground one.
            this.fetchDelayTimer.cancel();

            let delay = Prefs.getIntPref('update.defaultFetchDelay');
            this.fetchDelayTimer.initWithCallback(this.updateNextFeed.bind(this), delay,
                                                  TIMER_TYPE_SLACK);
            this.status = this.NORMAL_UPDATING;

            this.updateNextFeed();
        }

        if (newFeeds.length)
            Services.obs.notifyObservers(null, 'brief:feed-update-queued', '');
    }.task(),

    // See FeedUpdateService.
    stopUpdating: function FeedUpdateServiceInternal_stopUpdating() {
        if (this.status != this.NOT_UPDATING)
            this.finishUpdate('cancelled');
    },

    updateTimerBeat: function FeedUpdateService_updateTimerBeat() {
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
        let feedsToUpdate = Storage.getAllFeeds().filter(
            f => f.updateInterval == 0 && itsGlobalUpdateTime ||
                 f.updateInterval > 0 && now - f.lastUpdated > f.updateInterval
        )

        if (feedsToUpdate.length)
            this.updateFeeds(feedsToUpdate, feedsToUpdate.length, true);

        if (itsGlobalUpdateTime)
            Prefs.setIntPref('update.lastUpdateTime', Math.round(now / 1000));
    },


    updateNextFeed: function* FeedUpdateServiceInternal_updateNextFeed() {
        // All feeds in the update queue may have already been requested,
        // because we don't cancel the timer until after all feeds are completed.
        let feed = this.updateQueue.shift();
        if (!feed)
            return;

        Services.obs.notifyObservers(null, 'brief:feed-loading', feed.feedID);

        let fetcher = new FeedFetcher(feed.feedURL, true);

        try {
            let { document, parsedFeed } = yield fetcher.done;

            let newEntriesCount = yield Storage.processFeed(feed.feedID, parsedFeed, document);
            if (newEntriesCount > 0) {
                this.newEntriesCount += newEntriesCount;
                this.latestChangedFeed = feed;
                this.feedsWithNewEntriesCount++;
            }
        }
        catch (ex if ex.message == 'error') {
            var error = true;
        }
        catch (ex if ex.message == 'cancelled') {
        }
        finally {
            let timeSinceRefresh = Date.now() - feed.lastFaviconRefresh;
            if (!feed.favicon || timeSinceRefresh > FAVICON_REFRESH_INTERVAL)
                new FaviconFetcher(feed);

            this.completedFeeds.push(feed);

            Services.obs.notifyObservers(null, 'brief:feed-updated', feed.feedID);
            if (error)
                Services.obs.notifyObservers(null, 'brief:feed-error', feed.feedID);

            if (this.completedFeeds.length == this.scheduledFeeds.length)
                this.finishUpdate('completed');
        }
    }.task(),


    finishUpdate: function FeedUpdateServiceInternal_finishUpdate(aReason) {
        this.status = this.NOT_UPDATING;
        this.fetchDelayTimer.cancel();

        let showNotification = Prefs.getBoolPref('update.showNotification');
        if (this.feedsWithNewEntriesCount > 0 && showNotification) {
            let bundle = Services.strings.createBundle('chrome://brief/locale/brief.properties');
            let alertTitle = bundle.GetStringFromName('updateAlertTitle');

            let newForms = bundle.GetStringFromName('updateAlertText.new.pluralForms');
            let newString = getPluralForm(this.newEntriesCount, newForms);

            let itemForms = bundle.GetStringFromName('updateAlertText.item.pluralForms');
            let itemString = getPluralForm(this.newEntriesCount, itemForms);

            let feedForms = bundle.GetStringFromName('updateAlertText.feed.pluralForms');
            let feedString = getPluralForm(this.feedsWithNewEntriesCount, feedForms);

            let alertText;

            if (this.feedsWithNewEntriesCount == 1) {
                let feedTitle = this.latestChangedFeed.title;
                feedTitle = feedTitle.length < 35 ? feedTitle : feedTitle.substr(0, 35) + '\u2026';

                alertText = bundle.formatStringFromName('updateAlertText.singleFeedMessage',
                                                        [feedTitle, newString, itemString], 3);
                alertText = alertText.replace('#numItems', this.newEntriesCount);
            }
            else {
                alertText = bundle.formatStringFromName('updateAlertText.multpleFeedsMessage',
                                                        [newString, itemString, feedString], 3);
                alertText = alertText.replace('#numItems', this.newEntriesCount)
                                     .replace('#numFeeds', this.feedsWithNewEntriesCount);
            }

            try {
                let alertsService = Cc['@mozilla.org/alerts-service;1'].getService(Ci.nsIAlertsService);
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
        this.latestChangedFeed = null;
        this.scheduledFeeds = [];
        this.updateQueue = [];

        Services.obs.notifyObservers(null, 'brief:feed-update-finished', aReason);
    },

    // See FeedUpdateService.
    addFeed: function*(aURL) {
        let fetcher = new FeedFetcher(aURL, false);
        let { document, parsedFeed } = yield fetcher.done;
        Storage.ensureHomeFolder();

        // Just add a livemark, the feed will be updated by the bookmark observer.
        let livemarks = Cc['@mozilla.org/browser/livemark-service;2']
                        .getService(Ci.mozIAsyncLivemarks);
        livemarks.addLivemark({
            title: parsedFeed.title.text,
            feedURI: Services.io.newURI(aURL, null, null),
            siteURI: parsedFeed.link,
            parentId: Prefs.getIntPref('homeFolder'),
            index: Ci.nsINavBookmarksService.DEFAULT_INDEX,
        })
    }.task(),

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
                this.updateTimerBeat();
            break;

        case 'quit-application':
            Services.obs.removeObserver(this, 'brief:feed-updated');
            Services.obs.removeObserver(this, 'quit-application');
            Prefs.removeObserver('', this);
            break;

        }
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver])

}


/**
 * A worker object that downloads and parses a feed. Its |done| property is
 * a Promise that resolves to an object containing the following properties:
 * document <DOM document>: downloaded XML document, or null
 * parsedFeed <nsIFeedContainer>: parsed feed data, or null
 *
 * @param aURL [string]
 *        URL of the feed.
 * @param aCancelable [boolean]
 *        Indicates if the request can be canceled by brief:feed-update-finished
 *        notification.
 */
function FeedFetcher(aURL, aCancelable) {
    this.url = aURL;
    this.cancelable = aCancelable;
    this.deferred = PromiseUtils.defer();
    this.done = this.deferred.promise;

    this.parser = Cc['@mozilla.org/feed-processor;1'].createInstance(Ci.nsIFeedProcessor);
    this.parser.listener = this;

    Services.obs.addObserver(this, 'brief:feed-update-finished', false);

    this.requestFeed();
}

FeedFetcher.prototype = {

    request: null,
    parser: null,
    timeout: null,

    finished: false,

    requestFeed: function FeedFetcher_requestFeed() {
        this.request = Cc['@mozilla.org/xmlextras/xmlhttprequest;1']
                       .createInstance(Ci.nsIXMLHttpRequest);

        this.request.mozBackgroundRequest = Prefs.getBoolPref('update.suppressSecurityDialogs');
        this.request.open('GET', this.url, true);
        this.request.channel.loadFlags |= Ci.nsIRequest.VALIDATE_ALWAYS;
        this.request.overrideMimeType('application/xml');
        this.request.onload = this.onRequestLoad.bind(this);
        this.request.onerror = this.onRequestError.bind(this);
        this.request.send(null);

        this.timeout = wait(FEED_FETCHER_TIMEOUT);
        this.timeout.then(
            () => {
                this.request.abort();
                this.finish('error');
            },
            reason => { if (reason != 'cancelled') throw reason }
        )
    },

    onRequestError: function() {
        // See /extensions/venkman/resources/content/venkman-jsdurl.js#983 et al.
        const I_LOVE_NECKO_TOO = 2152398850;

        if (this.request.channel.status == I_LOVE_NECKO_TOO) {
            this.request.abort();
            this.requestFeed();
        }
        else {
            this.finish('error', null);
        }
    },

    onRequestLoad: function() {
        this.timeout.cancel();
        try {
            let uri = Services.io.newURI(this.url, null, null);
            this.parser.parseFromString(this.request.responseText, uri);
        }
        catch (ex) {
            this.finish('error', null);
        }
    },

    // nsIFeedResultListener
    handleResult: function FeedFetcher_handleResult(aResult) {
        // Prevent handleResult from being called twice, which seems to
        // sometimes happen with parsing errors.
        this.parser.listener = null;

        if (aResult && aResult.doc)
            this.finish('ok', aResult.doc.QueryInterface(Ci.nsIFeed));
        else
            this.finish('error', null);
    },

    finish: function FeedFetcher_finish(aStatus, aParsedFeed) {
        if (this.finished)
            return;

        let document = this.request.responseXML;

        Services.obs.removeObserver(this, 'brief:feed-update-finished');
        this.request = null;
        this.timeout.cancel();
        this.parser.listener = null;

        this.finished = true;

        if (aStatus == 'ok')
            this.deferred.resolve({ document: document, parsedFeed: aParsedFeed });
        else
            this.deferred.reject(new Error(aStatus));
    },

    observe: function FeedFetcher_observe(aSubject, aTopic, aData) {
        if (aData == 'cancelled' && this.cancelable) {
            this.request.abort();
            this.finish('cancelled', null);
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

    let chan;
    if (Services.vc.compare(Services.appinfo.version, 47) > 0) {
        chan = Services.io.newChannelFromURI2(faviconURI, null,
                Services.scriptSecurityManager.getSystemPrincipal(),
                null,
                Components.interfaces.nsILoadInfo.SEC_NORMAL,
                Components.interfaces.nsIContentPolicy.TYPE_OTHER
            );
    } else {
        chan = Services.io.newChannelFromURI(faviconURI);
    }
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
        Storage.changeFeedProperties({
            feedID: this.feed.feedID,
            lastFaviconRefresh: Date.now(),
            favicon: aFaviconString
        });
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

    getInterface: function(aIID) { return this.QueryInterface(aIID) },                 // nsIInterfaceRequestor
    confirmUnknownIssuer: function(aSocketInfo, aCert, aCertAddType) { return false }, // nsIBadCertListener
    confirmMismatchDomain: function(aSocketInfo, aTargetURL, aCert) { return false },
    confirmCertExpired: function(aSocketInfo, aCert) { return false },
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
