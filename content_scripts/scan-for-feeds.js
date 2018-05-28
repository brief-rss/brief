'use strict';

(function() {
    // Inspired by Firefox's getFeedsInfo in `browser/base/content/content.js`
    let links = document.querySelectorAll(
        'link[rel~=feed], link[rel~=alternate]:not([rel~=stylesheet])');

    function isFeed(link) {
        if(link.rel.match(/\bfeed\b/)) {
            return true;
        }
        if(link.type.match(/^\s*application\/(rss|atom)\+xml(\s*;.*)?$/i)) {
            return true;
        }
        return false;
    }

    // TODO: Test for "allowed to link" skipped
    let feeds = Array.from(links).filter(isFeed).map(l => ({linkTitle: l.title, url: l.href}));

    return feeds;
})();
