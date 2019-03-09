'use strict';

(function() {
    // Are we actually seeing a feed page?
    function isFeedPage() {
        // In a frame or view-source: this script is not loaded
        // Cannot check for GET/POST without intercepting the request
        const FEED_TYPES = [
            "application/atom+xml",
            "application/rss+xml",
        ];
        if(FEED_TYPES.includes(document.contentType)) {
            return true;
        }
        // contentType - Firefox was checking only
        // TEXT_HTML, APPLICATION_OCTET_STREAM and XML-mentioning ones
        const ROOTS = "rss:root, feed:root, RDF:root"; // Also see ROOTS in modules/updater.js
        let root = document.querySelector(ROOTS);
        if(root !== null) {
            if(root.localName == "RDF") {
                return Array.from(root.attributes).some(
                    attr => attr.value == "http://purl.org/rss/1.0/"
                    // Firefox used to grep also for
                    // http://www.w3.org/1999/02/22-rdf-syntax-ns#
                );
            }
            return true;
        }
        return false;
    }
    if(isFeedPage()) {
        let TITLE = "RDF > *|title, channel > *|title, *|feed > *|title";
        let linkTitle = document.querySelector(TITLE).textContent || "";
        return [{linkTitle, url: document.location.href, kind: 'self'}];
    }

    // Ok, not a feed page itself, any links to feeds?
    // Inspired by Firefox's getFeedsInfo in `browser/base/content/content.js`
    let links = document.querySelectorAll(
        'link[rel~=feed], link[rel~=alternate]:not([rel~=stylesheet])');

    function isFeedLink(link) {
        if(link.rel.match(/\bfeed\b/)) {
            return true;
        }
        if(link.type.match(/^\s*application\/(rss|atom)\+xml(\s*;.*)?$/i)) {
            return true;
        }
        return false;
    }

    // TODO: Test for "allowed to link" skipped
    let feeds = Array.from(links).filter(isFeedLink).map(
        l => ({linkTitle: l.title, url: l.href, kind: 'link'})
    );

    return feeds;
})();
