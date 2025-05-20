//@ts-strict
import {Prefs} from "./prefs.js";
import {Comm, wait, getPluralForm} from "./utils.js";
import {fetchFeed} from "./feed-fetcher.js";
import {updateFavicon} from "./favicon-fetcher.js";

/**
 * @typedef {import("/modules/database.js").Feed} Feed
 * @typedef {import("/modules/database.js").Database} Database
 */

export let FeedUpdater = {
    UPDATE_TIMER_INTERVAL: 60000, // 1 minute
    FAVICON_REFRESH_INTERVAL: 14*24*60*60*1000, // 2 weeks

    FEED_ICON_URL: '/skin/brief-icon-32.png',

    /** @type {string[]} */
    queue: [],
    /** @type {string[]} */
    priority: [],
    /** @type {string[]} */
    underway: [],
    /** @type {string[]} */
    completed: [],

    updatedFeeds: new Map(),

    /** @type Database? */
    _db: null,

    get db() {
        if(!this._db) {
            throw new Error("Updater used before initialization");
        }
        return this._db;
    },

    get active() {
        return this.queue.length + this.underway.length > 0;
    },

    get progress() {
        let total = this.completed.length + this.underway.length + this.queue.length;
        if(total === 0) {
            return 1.0;
        } else {
            return this.completed.length / total;
        }
    },

    /** @param {{db: Database}} arg */
    async init({db}) {
        this._db = db;
        /*spawn*/ this._scheduler();

        Comm.registerObservers({
            'update-all': () => this.updateAllFeeds(),
            'update-feeds': ({feeds}) => this.updateFeeds(feeds),
            'update-stop': () => this.stopUpdating(),
            'update-query-status': () => this._broadcastStatus(),
        });
        browser.notifications.onClicked.addListener(() => {
            browser.tabs.create({url: '/ui/brief.xhtml'});
        });
    },

    /**
     * @param {(string | Feed)[]} feeds
     * @param {{background: boolean?}} options
     */
    async updateFeeds(feeds, options={background: false}) {
        let queueLength = this.queue.length;
        let {background} = options;
        if(!Array.isArray(feeds)) {
            feeds = [feeds];
        }
        //TODO: process folders recursively
        let feedIds = feeds.map(feed => typeof feed === 'string' ? feed : feed.feedID);
        // Enqueue the feeds that are not underway
        feedIds = feedIds.filter(feed => !this.underway.includes(feed));
        if(feedIds.length === 0) {
            return;
        }
        for(let id of feedIds) {
            if(!background && !this.priority.includes(id)) {
                this.priority.push(id);
            }
            if(!this.queue.includes(id)) {
                this.queue.push(id);
                this.completed = this.completed.filter(f => f != id);
            }
        }
        this._broadcastStatus();
        console.log(`Brief: enqueued ${this.queue.length - queueLength} feeds`);

        if(queueLength === 0) {
            /*spawn*/ this._worker();
        }
    },

    /**
     * @param {{background: boolean?}} options
     */
    async updateAllFeeds(options={background: false}) {
        let {background} = options;
        let feeds = this.db.feeds.filter(f => !f.hidden && !f.isFolder);
        this.updateFeeds(feeds, {background});
    },

    async stopUpdating() {
        this.priority = [];
        this.queue = [];
        this.underway = [];
        this._finish();
        this._broadcastStatus();
    },

    async _scheduler() {
        await wait(Prefs.get('update.startupDelay'));
        while(true) { // eslint-disable-line no-constant-condition
            let now = Date.now();

            let globalUpdatingEnabled = Prefs.get('update.enableAutoUpdate');
            // Prefs are in seconds due to legacy
            let lastGlobalUpdate = Prefs.get('update.lastUpdateTime') * 1000;
            let nextGlobalUpdate = lastGlobalUpdate + (Prefs.get('update.interval') * 1000);

            let doGlobalUpdate = globalUpdatingEnabled && now > nextGlobalUpdate;
            if(doGlobalUpdate) {
                Prefs.set('update.lastUpdateTime', now / 1000);
            }

            let candidates = [];
            for(let feed of this.db.feeds.filter(f => !f.hidden && !f.isFolder)) {
                let update;
                if(feed.updateInterval === 0) {
                    update = doGlobalUpdate;
                } else {
                    update = now > (feed.lastUpdated + feed.updateInterval);
                }
                if(update) {
                    candidates.push(feed);
                }
            }
            if(candidates.length !== 0) {
                console.log("Brief: scheduling feeds", candidates);
                this.updateFeeds(candidates, {background: true});
            }
            await wait(this.UPDATE_TIMER_INTERVAL);
        }
    },

    async _worker() {
        while(this.queue.length > 0) {
            // Get a feed for update...
            let feedID = this.priority.shift();
            if(feedID === undefined) {
                feedID = this.queue.shift();
            } else {
                this.queue = this.queue.filter(f => f != feedID);
            }
            if(feedID === undefined) {
                throw new Error("Impossible: non-empty queue is empty");
            }
            this.underway.push(feedID);
            this._broadcastStatus();

            /*spawn*/ this.update(feedID)
                .catch(err => console.error('Brief: fetch error', err))
                .then(() => {
                    this.underway = this.underway.filter(f => f !== feedID);
                    this.completed.push(feedID);
                    this._broadcastStatus();
                    if(this.queue.length === 0 && this.underway.length === 0) {
                        this._finish();
                    }
                });

            if(this.queue.length === 0) {
                return;
            }
            if(this.priority.length > 0) {
                await wait(Prefs.get('update.defaultFetchDelay'));
            } else {
                await wait(Prefs.get('update.backgroundFetchDelay'));
            }
        }
    },

    /** @param {string} feedID */
    async update(feedID) {
        let feed = this.db.getFeed(feedID);
        if(feed === undefined) { // Deleted from DB while in queue?
            return;
        }

        let allow_cached = Prefs.get('update.allowCachedResponses');
        let parsedFeed = await fetchFeed(feed, {allow_cached});
        if(parsedFeed) {
            let pushResults = await this.db.pushUpdatedFeed({feed, parsedFeed});
            let {newEntries} = pushResults;
            if(newEntries.length > 0) {
                let entryCount = this.updatedFeeds.get(feedID);
                if(entryCount === undefined) {
                    entryCount = 0;
                }
                entryCount += newEntries.length;
                this.updatedFeeds.set(feedID, entryCount);
            }
        }

        //Do we need to refresh the favicon?
        let nextFaviconRefresh = feed.lastFaviconRefresh + this.FAVICON_REFRESH_INTERVAL;
        feed = this.db.getFeed(feedID); // Updated websiteURL
        if(feed === undefined) { // Deleted from DB while in queue?
            return;
        }
        if(!feed.favicon || feed.favicon === 'no-favicon' || Date.now() > nextFaviconRefresh) {
            /*spawn*/ updateFavicon({feed, db: this.db}).catch(error => {
                console.warn(`Brief failed to update favicon for ${feed.feedURL}:`, error);
            });
        }
    },

    async _finish() {
        this.completed = [];
        console.log('Brief: update finished');

        let feedCount = this.updatedFeeds.size;
        let entryCount = Array.from(this.updatedFeeds.values()).reduce((a, b) => a + b, 0);
        let firstFeed = Array.from(this.updatedFeeds.keys())[0];
        this.updatedFeeds = new Map();

        if(!Prefs.get('update.showNotification') || feedCount === 0) {
            return;
        }


        let alertTitle = browser.i18n.getMessage('updateAlertTitle');

        let newForms = browser.i18n.getMessage('updateAlertText_new_pluralForms');
        let newString = getPluralForm(entryCount, newForms);

        let itemForms = browser.i18n.getMessage('updateAlertText_item_pluralForms');
        let itemString = getPluralForm(entryCount, itemForms);

        let feedForms = browser.i18n.getMessage('updateAlertText_feed_pluralForms');
        let feedString = getPluralForm(feedCount, feedForms);

        let alertText;

        if (feedCount == 1) {
            let feed = this.db.getFeed(firstFeed);
            if(feed === undefined) { // Deleted from DB during update?
                return;
            }
            let feedTitle = feed.title;
            feedTitle = feedTitle.length < 35 ? feedTitle : feedTitle.substr(0, 35) + '\u2026';

            alertText = browser.i18n.getMessage(
                'updateAlertText_singleFeedMessage', [feedTitle, newString, itemString]);
            alertText = alertText.replace('#numItems', entryCount);
        }
        else {
            alertText = browser.i18n.getMessage(
                'updateAlertText_multpleFeedsMessage', [newString, itemString, feedString]);
            alertText = alertText
                .replace('#numItems', entryCount)
                .replace('#numFeeds', feedCount.toString());
        }
        browser.notifications.create({
            type: 'basic',
            title: alertTitle,
            message: alertText,
        });
    },

    _broadcastStatus() {
        Comm.broadcast('update-status', {
            active: this.active,
            progress: this.progress,
            underway: this.underway,
        });
    },
};
