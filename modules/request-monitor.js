export function init() {
    console.debug("Initializing the feed request monitor");
    browser.webRequest.onHeadersReceived.addListener(
        headerCheck,
        {types: ["main_frame"], urls: ["http://*/*", "https://*/*"]},
        ["responseHeaders", "blocking"],
    );
}

function parseContentType(value) {
    if(value === undefined || value === null) {
        return {mime: 'application/octet-stream', encoding: 'utf-8'};
    }
    let [contentType, ...pairs] = value.split(';');
    let encoding = 'utf-8';
    for(let pair of pairs) {
        let [key, value] = pair.split('=');
        if(key.trim() === 'charset') {
            encoding = value.trim();
        }
    }
    return {mime: contentType.trim(), encoding};
}

const KNOWN_FEED_TYPES = [
    'application/atom+xml',
    'application/rss+xml',
];
/*
// Let's not consider 'application/octet-stream' for now
// and leave the XML-based MIME types for the content script
const MAYBE_FEED_TYPES = [
    'application/octet-stream',
    'application/xml',
    'text/html',
    'text/xml',
    // and anything with `+xml` as a special case
];
*/

function headerCheck({tabId, url, responseHeaders}) {
    let contentType = responseHeaders
        .filter(h => h.name.toLowerCase() == 'Content-Type'.toLowerCase())
        .filter(h => h.value !== undefined)
        .map(h => h.value)[0];
    let {mime} = parseContentType(contentType);
    if(KNOWN_FEED_TYPES.includes(mime)) {
        let previewUrl = "/ui/brief.xhtml?preview=" + encodeURIComponent(url);
        browser.tabs.update(tabId, {url: previewUrl}); // No loadReplace: still on old page
        return {cancel: true};
    }
}
