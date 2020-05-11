import {SNIFF_WINDOW, sniffedToBeFeed} from "./xml-sniffer.js";

export function init() {
    console.debug("Initializing the feed request monitor");
    browser.webRequest.onHeadersReceived.addListener(
        checkHeaders,
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

// Let's not consider 'application/octet-stream' for now
const MAYBE_FEED_TYPES = [
    //'application/octet-stream',
    'application/xml',
    'text/html',
    'text/xml',
    // and anything with `+xml` as a special case
];


function checkHeaders({requestId, tabId, url, responseHeaders}) {
    if(tabId === browser.tabs.TAB_ID_NONE) {
        return; // This is not a real tab, so not redirecting anything
    }
    let contentType = responseHeaders
        .filter(h => h.name.toLowerCase() == 'Content-Type'.toLowerCase())
        .filter(h => h.value !== undefined)
        .map(h => h.value)[0];
    let {mime, encoding} = parseContentType(contentType);
    if(KNOWN_FEED_TYPES.includes(mime)) {
        let previewUrl = "/ui/brief.xhtml?preview=" + encodeURIComponent(url);
        browser.tabs.update(tabId, {url: previewUrl}); // No loadReplace: still on old page
        return {cancel: true};
    }
    if(MAYBE_FEED_TYPES.includes(mime) || mime.includes('+xml')) {
        let filter = browser.webRequest.filterResponseData(requestId);
        let chunks = [];

        filter.ondata = ({data}) => {
            filter.write(data);
            chunks.push(data);
            let totalBytes = chunks.map(c => c.byteLength).reduce((a, b) => a + b, 0);
            if(totalBytes >= SNIFF_WINDOW) {
                checkContent(chunks, {encoding, url, tabId});
                filter.disconnect();
            }
        };
        filter.onstop = () => {
            checkContent(chunks, {encoding, url, tabId});
            filter.close();
        };
    }
}

function checkContent(buffers, {encoding, url, tabId}) {
    if(buffers.length === 0) {
        return;
    }

    let text;
    try {
        text = parseBuffers({buffers, encoding, length: SNIFF_WINDOW});
    } catch(e) {
        return; // Fallback: not a feed
    }

    if(sniffedToBeFeed(text)) {
        console.log('feed detected, redirecting to preview page for', url);
        let previewUrl = "/ui/brief.xhtml?preview=" + encodeURIComponent(url);
        browser.tabs.update(tabId, {url: previewUrl, loadReplace: true});
    }
}

function parseBuffers({buffers, encoding, length}) {
    let decoder = new TextDecoder(encoding, {fatal: true}); // Throws: invalid encoding
    let text = "";
    let bytesRemaining = length;
    for(let buffer of buffers.slice(0, -1)) {
        text += decoder.decode(buffer, {stream: true}); // Throws: failure decoding
        bytesRemaining -= buffer.byteLength;
    }
    text += decoder.decode(
        buffers[buffers.length - 1].slice(0, bytesRemaining),
        {stream: true},
    ); // Throws: error decoding
    return text;
}
