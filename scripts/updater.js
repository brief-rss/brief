'use strict';

const UPDATE_TIMER_INTERVAL = 60000; // 1 minute
const FEED_FETCHER_TIMEOUT = 25000; // 25 seconds
const FAVICON_REFRESH_INTERVAL = 14*24*60*60*1000; // 2 weeks

const FEED_ICON_URL = '/skin/brief-icon-32.png';


let FeedUpdater = {
    queue: [],
    backgroundQueue: [],
    stats: {
        scheduled: 0,
        completed: 0,
    },
    active: false,

    async init() {
        await wait(Prefs.get('update.startupDelay'));

        /*spawn*/ this._scheduler();
    },

    async updateFeeds(feeds, {background}) {
        if(!Array.isArray(feeds)) {
            feeds = [feeds];
        }
        feeds = feeds.map(feed => feed.feedID || feed);
        feeds = feeds.filter(feed => !this.queue.includes(feed));
        if(background) {
            let feeds = feeds.filter(feed => !this.backgroundQueue.includes(feed));
            this.stats.scheduled += feeds.length;
            this.backgroundQueue.push(...feeds);
        } else {
            this.stats.scheduled += feeds.length;
            this.queue.push(...feeds);
            let background = this.backgroundQueue.length;
            this.backgroundQueue = this.backgroundQueue.filter(
                feed => !feeds.includes(feed));
            this.stats.scheduled -= background - this.backgroundQueue.length;
        }
        if(!this.active) {
            /*spawn*/ this._worker();
        }
    },

    async updateAllFeeds({background}) {
        let feeds = Database.feeds.filter(f => !f.hidden && !f.isFolder);
        this.updateFeeds(feeds, {background});
    },

    async stopUpdating() {
    },

    async _scheduler() {
    },

    async _worker() {
        while(this.queue.length || this.backgroundQueue.length) {
            break;
        }
    },
};


let FeedFetcher = {
    async fetchFeed(feed) {
        let response = await Promise.race([
            fetch(feed.feedURL, {redirect: 'follow', cache: 'no-cache'}),
            wait(FEED_FETCHER_TIMEOUT),
        ]);
        if(!response || !response.ok) {
            return;
        }
        let text = await response.text();

        let parser = new DOMParser();
        let doc = parser.parseFromString(text, "application/xml");
        if(doc.documentElement.localName === 'parseerror') {
            return;
        }

        // Ok, we've got a feed, is this gonna help us???



    },
};

let FaviconFetcher = {
    async updateFavicon(feed) {
        let favicon = await this._fetchFavicon(feed);
        if(!favicon) {
            favicon = 'no-favicon';
        }
        await Database.modifyFeed({
            feedID: feed.feedID,
            lastFaviconRefresh: Date.now(),
            favicon
        });
    },
    async _fetchFavicon(feed) {
        if (!feed.websiteURL) {
            return;
        }

        // Use websiteURL instead of feedURL for resolving the favicon URL,
        // because many websites use services like Feedburner for generating their
        // feeds and we would get the Feedburner's favicon instead.
        let faviconUrl = new URL('/favicon.ico', feed.websiteURL);

        let response = await fetch(faviconUrl, {redirect: 'follow'});

        if(!response.ok) {
            return;
        }
        let blob = await response.blob();
        if(blob.size === 0) {
            return;
        }

        let reader = new FileReader();
        let favicon = await new Promise((resolve, reject) => {
            reader.onload = e => resolve(e.target.result);
            reader.onerror = e => reject(e);
            reader.readAsDataURL(blob);
        });

        return favicon;
    },
};

const NAMESPACES = {
};

const FEED_FORMATS = [
    {
        name: '/rss2',
        signature: 'rss:root',
    },
    {},
    {},
];
