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

    //TODO: this is an implementation detail, is there any better way?
    if(document.querySelector('script[src="chrome://browser/content/feeds/subscribe.js"]')) {
        links = [{rel: 'feed', title: document.title, href: document.location.href}];
    }

    // FIXME: Test for "allowed to link" skipped
    let feeds = Array.from(links).filter(isFeed).map(l => ({title: l.title, url: l.href}));

    return feeds;
})()
