'use strict';

let Feeds = {
    _watchFeedList: null,

    async init() {
        this._watchFeedList = browser.runtime.connect({name: 'watch-feed-list'});
        this._watchFeedList.onMessage.addListener(feeds => this._updateFeeds(feeds));
    },

    _updateFeeds(feeds) {
        for(let feed of feeds) {
            for(let key of Object.getOwnPropertyNames(feed)) {
                if(key === 'favicon')
                    delete feed.favicon;
                if(feed[key] === null)
                    delete feed[key];
            }
        }
        browser.storage.local.set({feeds});
        browser.storage.sync.set({feeds}); // Fx53+, fails with console error on 52
        console.debug(`updated ${feeds.length} feeds`);
    },
};
