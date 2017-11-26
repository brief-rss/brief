'use strict';



let FeedUpdater = {
    UPDATE_TIMER_INTERVAL: 60000, // 1 minute
    FAVICON_REFRESH_INTERVAL: 14*24*60*60*1000, // 2 weeks

    FEED_ICON_URL: '/skin/brief-icon-32.png',

    queue: [],
    priority: [],
    underway: [],
    completed: [],

    updatedFeeds: new Map(),

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

    async init() {
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

    async updateFeeds(feeds, options) {
        let queueLength = this.queue.length;
        let {background} = options || {};
        if(!Array.isArray(feeds)) {
            feeds = [feeds];
        }
        //TODO: process folders recursively
        feeds = feeds.map(feed => feed.feedID || feed);
        // Enqueue the feeds that are not underway
        feeds = feeds.filter(feed => !this.underway.includes(feed));
        if(feeds.length === 0) {
            return;
        }
        for(let id of feeds) {
            if(!background && !this.priority.includes(id)) {
                this.priority.push(id);
            }
            if(!this.queue.includes(id)) {
                this.queue.push(id);
                this.completed = this.completed.filter(f => f != id);
            }
        }
        this._broadcastStatus();
        console.log(`Brief: enqueued ${this.queue.length - queueLength} feeds`)

        if(queueLength === 0) {
            /*spawn*/ this._worker();
        }
    },

    async updateAllFeeds(options) {
        let {background} = options || {};
        let feeds = Database.feeds.filter(f => !f.hidden && !f.isFolder);
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
        while(true) {
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
            for(let feed of Database.feeds.filter(f => !f.hidden && !f.isFolder)) {
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
            this.underway.push(feedID);

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

    async update(feedID) {
        let feed = Database.getFeed(feedID);
        if(feed === undefined) { // Deleted from DB while in queue?
            return;
        }

        let parsedFeed = await FeedFetcher.fetchFeed(feed);
        if(parsedFeed) {
            let pushResults = await Database.pushUpdatedFeed({feed, parsedFeed});
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
        feed = Database.getFeed(feedID); // Updated websiteURL
        if(!feed.favicon || feed.favicon === 'no-favicon' || Date.now() > nextFaviconRefresh) {
            /*spawn*/ FaviconFetcher.updateFavicon(feed);
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
            let feedTitle = Database.getFeed(firstFeed).title;
            feedTitle = feedTitle.length < 35 ? feedTitle : feedTitle.substr(0, 35) + '\u2026';

            alertText = browser.i18n.getMessage(
                'updateAlertText_singleFeedMessage', [feedTitle, newString, itemString]);
            alertText = alertText.replace('#numItems', entryCount);
        }
        else {
            alertText = browser.i18n.getMessage(
                'updateAlertText_multpleFeedsMessage', [newString, itemString, feedString]);
            alertText = alertText.replace('#numItems', entryCount)
                                 .replace('#numFeeds', feedCount);
        }
        browser.notifications.create({
            type: 'basic',
            title: alertTitle,
            message: alertText,
        });
    },

    _broadcastStatus() {
        Comm.broadcast('update-status', {active: this.active, progress: this.progress});
    },
};


let FaviconFetcher = {
    async updateFavicon(feed) {
        if(Comm.verbose) {
            console.log("Brief: fetching favicon for", feed);
        }
        let updatedFeed = {
            feedID: feed.feedID,
            lastFaviconRefresh: Date.now()
        };
        let favicon = await this._fetchFavicon(feed);
        if(favicon) {
            updatedFeed.favicon = favicon;
        }
        await Database.modifyFeed(updatedFeed);
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


let FeedFetcher = {
    TIMEOUT: 25000, // 25 seconds

    async fetchFeed(feed) {
        let url = feed.feedURL || feed;
        let request = new XMLHttpRequest();
        request.open('GET', url);
        request.overrideMimeType('application/xml');
        if(!Prefs.get('update.allowCachedResponses')) {
            request.setRequestHeader('Cache-control', 'no-cache');
        }
        request.responseType = 'document';

        let doc = await Promise.race([
            xhrPromise(request).catch(() => undefined),
            wait(this.TIMEOUT),
        ]);
        if(!doc) {
            console.error("failed to fetch", url);
            return;
        }

        if(doc.documentElement.localName === 'parseerror') {
            console.error("failed to parse as XML", url);
            return;
        }

        let root = doc.querySelector(this.ROOTS);
        let result = this._parseNode(root, this.FEED_PROPERTIES);
        if(!result || !result.items || !result.items.length > 0) {
            console.warn("failed to find any items in", url);
        } else {
            let item = result.items[0];
            if(!item.published && !item.updated) {
                console.warn('no timestamps in', item, 'raw', item._node);
            }
        }
        result.language = result.language || doc.documentElement.getAttribute('xml:lang');
        return result;
    },

    ROOTS: ['RDF, channel, *|feed'],

    _parseNode(node, properties) {
        let props = {};
        let keyMap = this._buildKeyMap(properties);
        //TODO: handle attributes
        let children = Array.from(node.children);
        children.push(...node.attributes);
        for(let child of children) {
            let nsPrefix = this._nsPrefix(child.namespaceURI);
            if(nsPrefix === 'IGNORE:') {
                continue;
            } else if(nsPrefix && nsPrefix[0] === '[') {
                if(Comm.verbose) {
                    console.log('unknown namespace', nsPrefix, child);
                }
                continue;
            }
            let nodeKey = nsPrefix + child.localName;
            let destinations = keyMap.get(nodeKey);
            if(destinations === undefined) {
                let parent = this._nsPrefix(node.namespaceURI) + node.localName;
                if(Comm.verbose) {
                    console.log('unknown key', nodeKey, 'in', node);
                }
                continue;
            }
            for(let {name, type, array} of destinations) {
                if(name === 'IGNORE') {
                    continue;
                }
                let handler = this.handlers[type];
                if(handler) {
                    let value = handler.call(this, child);
                    if(value === undefined || value === null) {
                        continue;
                    }
                    if(name === '{merge}') {
                        Object.assign(props, value);
                        continue;
                    }
                    if(array) {
                        if(props[name] === undefined) {
                            props[name] = [];
                        }
                        props[name].push(value);
                    } else {
                        props[name] = value;
                    }
                } else {
                    console.error('missing handler', type);
                }
            }
        }
        return props;
    },

    _buildKeyMap(known_properties) {
        let map = new Map();
        for(let [name, type, tags] of known_properties) {
            let array = false;
            if(name.slice(name.length - 2) === '[]') {
                name = name.slice(0, name.length - 2);
                array = true;
            }
            for(let src of tags) {
                if(src.tag !== undefined) {
                    type = src.type || type;
                    src = src.tag;
                }
                let destinations = map.get(src) || [];
                destinations.push({name, type, array});
                map.set(src, destinations);
            }
        }
        return map;
    },

    FEED_PROPERTIES: [
        // Name, handler name, list of known direct children with it
        ['title', 'text', ["title", "rss1:title", "atom03:title", "atom:title"]],
        ['subtitle', 'text', ["description", "dc:description", "rss1:description",
                              "atom03:tagline", "atom:subtitle"]],
        ['link', 'url', ["link", "rss1:link"]],
        ['link', 'atomLinkAlternate', ["atom:link", "atom03:link"]],
        ['items[]', 'entry', ["item", "rss1:item", "atom:entry", "atom03:entry"]],
        ['generator', 'text', ["generator", "rss1:generator", "atom03:generator", "atom:generator"]],
        ['updated', 'date', ["pubDate", "rss1:pubDate", "lastBuildDate", "atom03:modified", "dc:date",
                             "dcterms:modified", "atom:updated"]],
        ['language', 'lang', ["language", "rss1:language", "xml:lang"]],

        ['{merge}', 'feed', ["rss1:channel"]],
        //and others Brief does not use anyway...
        //TODO: enclosures
        ['IGNORE', '', ["atom:id", "atom03:id", "atom:author", "atom03:author",
                        "category", "atom:category", "rss1:items"]],
    ],
    ENTRY_PROPERTIES: [
        ['title', 'text', ["title", "rss1:title", "atom03:title", "atom:title"]],
        ['link', 'permaLink', ["guid", "rss1:guid"]],
        ['link', 'url', ["link", "rss1:link"]],
        ['link', 'atomLinkAlternate', ["atom:link", "atom03:link"]],
        ['id', 'id', ["guid", "rss1:guid", "rdf:about", "atom03:id", "atom:id"]],
        ['authors[]', 'author', ["author", "rss1:author", "dc:creator", "dc:author",
                                  "atom03:author", "atom:author"]],
        ['summary', 'text', ["description", "rss1:description", "dc:description",
                             "atom03:summary", "atom:summary"]],
        ['content', 'html', ["content:encoded", "atom03:content", "atom:content"]],

        ['published', 'date', ["pubDate", "rss1:pubDate",
                               "atom03:issued", "dcterms:issued", "atom:published"]],
        ['updated', 'date', ["pubDate", "rss1:pubDate", "atom03:modified",
                             "dc:date", "dcterms:modified", "atom:updated"]],
        //and others Brief does not use anyway...
        ['IGNORE', '', ["atom:category", "atom03:category", "category", "rss1:category",
                        "comments", "wfw:commentRss", "rss1:comments",
                        "dc:language", "dc:format", "xml:lang", "dc:subject",
                        "enclosure", "dc:identifier"
                       ]],
        // TODO: should these really be all ignored?
    ],
    AUTHOR_PROPERTIES: [
        ['name', 'text', ["name", "atom:name", "atom03:name"]],
        ['IGNORE', '', ["atom:uri", "atom:email"]],
    ],

    handlers: {
        entry(node) {
            let props = this._parseNode(node, this.ENTRY_PROPERTIES);
            return props;
        },

        feed(node) {
            return this._parseNode(node, this.FEED_PROPERTIES);
        },

        text(nodeOrAttr) {
            if(nodeOrAttr.children !== undefined) {
                for(let child of nodeOrAttr.childNodes) {
                    switch(child.nodeType) {
                        case Node.TEXT_NODE:
                        case Node.CDATA_SECTION_NODE:
                            continue;
                        default:
                            console.warn('possibly raw html in', nodeOrAttr);
                            break;
                    }
                }
                return nodeOrAttr.textContent.trim()
            } else {
                return nodeOrAttr.value.trim()
            }
        },

        html(nodeOrAttr) {
            return this.handlers.text.call(this, nodeOrAttr);
        },

        lang(nodeOrAttr) {
            return this.handlers.text.call(this, nodeOrAttr);
        },

        author(node) {
            if(node.children.length > 0) {
                return this._parseNode(node, this.AUTHOR_PROPERTIES);
            } else {
                return this.handlers.text.call(this, node);
            }
        },

        url(node) {
            try {
                return new URL(node.textContent, node.baseURI);
            } catch(e) {
                console.warn('failed to parse URL', node.textContent, 'with base', node.baseURI);
            }
        },

        date(node) {
            let text = node.textContent.trim();
            // Support for Z timezone marker for UTC (mb 682781)
            let date = new Date(text.replace(/z$/i, "-00:00"));
            if (!isNaN(date)) {
                return date.toUTCString();
            }
            console.warn('failed to parse date', text);
            return null;
        },

        id(nodeOrAttr) {
            return this.handlers.text.call(this, nodeOrAttr);
        },

        atomLinkAlternate(node) {
            let rel = node.getAttribute('rel') || 'alternate';
            let known = ['alternate', 'http://www.iana.org/assignments/relation/alternate'];
            if(known.includes(rel)) {
                let text = node.getAttribute('href');
                let link;
                try {
                    link = new URL(text, node.baseURI);
                } catch(e) {
                    console.warn('failed to parse URL', text, 'with base', node.baseURI);
                }
                return link;
            }
        },

        permaLink(node) {
            let isPermaLink = node.getAttribute('isPermaLink');
            if(!isPermaLink || isPermaLink.toLowerCase() !== 'false') {
                try {
                    return new URL(node.textContent);
                } catch(e) {
                    console.warn('failed to parse absolute URL from GUID', node.textContent);
                }
            }
        },
    },

    _nsPrefix(uri) {
        uri = uri || "";
        if(this.IGNORED_NAMESPACES[uri]) {
            return "IGNORE:";
        }
        if (uri.toLowerCase().indexOf("http://backend.userland.com") == 0) {
            return "";
        }
        let prefix = this.NAMESPACES[uri];
        if(prefix === undefined) {
            prefix = `[${uri}]`;
        }
        if(prefix) {
            return prefix + ":";
        } else {
            return "";
        }
    },

    NAMESPACES: {
        "": "",
        "http://webns.net/mvcb/": "admin",
        "http://backend.userland.com/rss": "",
        "http://blogs.law.harvard.edu/tech/rss": "",
        "http://www.w3.org/2005/Atom": "atom",
        "http://purl.org/atom/ns#": "atom03",
        "http://purl.org/rss/1.0/modules/content/": "content",
        "http://purl.org/dc/elements/1.1/": "dc",
        "http://purl.org/dc/terms/": "dcterms",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf",
        "http://purl.org/rss/1.0/": "rss1",
        "http://my.netscape.com/rdf/simple/0.9/": "rss1",
        "http://wellformedweb.org/CommentAPI/": "wfw",
        "http://purl.org/rss/1.0/modules/wiki/": "wiki",
        "http://www.w3.org/XML/1998/namespace": "xml",
        "http://search.yahoo.com/mrss/": "media",
        "http://search.yahoo.com/mrss": "media",
    },
    IGNORED_NAMESPACES: {
        "http://www.w3.org/2000/xmlns/": "XML namespace definition",
        "http://purl.org/rss/1.0/modules/slash/": "Slashdot engine specific",
        "http://purl.org/rss/1.0/modules/syndication/": "Aggregator publishing schedule", // TODO: maybe use it?
        "http://www.livejournal.org/rss/lj/1.0/": "Livejournal metadata",
        "http://rssnamespace.org/feedburner/ext/1.0": "Feedburner metadata",
        "https://www.livejournal.com": "LJ",
        "com-wordpress:feed-additions:1": "wordpress",
    },
};
