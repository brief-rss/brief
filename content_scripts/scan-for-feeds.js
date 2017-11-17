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

    const BRIEF_URLS = [
        'brief://subscribe/%s',
        'chrome://brief/content/brief.xhtml?subscribe=%s',
    ];

    //TODO: this is an implementation detail, is there any better way?
    if(BrowserFeedWriter !== undefined) {
        links = [{rel: 'feed', title: document.title, href: document.location.href}];
        let button = document.getElementById('subscribeButton');
        if(button.dataset.briefHookReady === undefined) {
            button.dataset.briefHookReady = "true";
            let selectBox = document.getElementById('handlersMenuList');
            let options = Array.from(selectBox.children);
            let optionUrls = options.map(node => node.getAttribute('webhandlerurl') || '');

            let liveBookmarksMenuItem = document.getElementById("liveBookmarksMenuItem");

            let briefFallback = liveBookmarksMenuItem.cloneNode(false);
            briefFallback.removeAttribute("selected");
            briefFallback.textContent = "Brief";
            briefFallback.setAttribute("webhandlerurl", BRIEF_URLS[0]);

            let sep = liveBookmarksMenuItem.nextElementSibling.cloneNode(false);
            sep.textContent = liveBookmarksMenuItem.nextElementSibling.textContent;

            liveBookmarksMenuItem.after(sep);
            sep.after(briefFallback);

            button.addEventListener('click', event => {
                let activeUrl = selectBox.selectedOptions[0].getAttribute('webhandlerurl');
                if(BRIEF_URLS.includes(activeUrl)) {
                    console.log('An old Brief option selected for subscribing, intercepting');
                    event.stopImmediatePropagation();
                    event.preventDefault();
                    browser.runtime.sendMessage({
                        id: 'feedlist-add',
                        feeds: [{title: document.title, url: document.location.href}],
                        _type: 'master',
                    });
                }
            }, {capture: true});
        }
    }

    // TODO: Test for "allowed to link" skipped
    let feeds = Array.from(links).filter(isFeed).map(l => ({linkTitle: l.title, url: l.href}));

    return feeds;
})()
