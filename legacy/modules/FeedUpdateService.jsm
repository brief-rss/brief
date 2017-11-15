// Exported object exposing public properties.
const FeedUpdateService = Object.freeze({
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

    finalize: function FeedUpdateServiceInternal_init() {
        if(this.updateTimer !== undefined)
            this.updateTimer.cancel();

        Services.obs.removeObserver(this, 'brief:feed-updated');
        Services.obs.removeObserver(this, 'quit-application'); // TODO: remove when bootstrapped
        Prefs.removeObserver('', this);
        log("Brief: finalized FeedUpdateService");
    },

    // See FeedUpdateService.
    updateAllFeeds: function* FeedUpdateServiceInternal_updateAllFeeds(aInBackground) {
        yield Storage.ready;
        this.updateFeeds(Storage.getAllFeeds(), aInBackground);
    }.task(),

    // See FeedUpdateService.
    updateFeeds: function* FeedUpdateServiceInternal_updateFeeds(aFeeds, aInBackground) {
        yield Storage.ready;

        let feeds = aFeeds.map(feed => (typeof feed !== 'string') ? feed : Storage.getFeed(feed));

        // Don't add the same feed be added twice.
        let newFeeds = feeds.filter(feed => this.updateQueue.indexOf(feed) == -1);

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
        yield livemarks.addLivemark({
            title: parsedFeed.title.text,
            feedURI: Services.io.newURI(aURL, null, null),
            siteURI: parsedFeed.link,
            parentId: Prefs.getIntPref('homeFolder'),
            index: Ci.nsINavBookmarksService.DEFAULT_INDEX,
        });
        yield Storage.syncWithLivemarks();
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
            this.finalize();
            break;

        }
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver])

}

