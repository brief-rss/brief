import {parseFeed} from "./feed-parser.js";
import {wait, xhrPromise} from "./utils.js";

const DEFAULT_TIMEOUT = 25000; // Default fetch timeout

export async function fetchFeed(feed, {allow_cached = false} = {}) {
    let url = feed.feedURL || feed;
    let request = new XMLHttpRequest();
    request.open('GET', url);
    request.overrideMimeType('application/xml');
    if(!allow_cached) {
        request.setRequestHeader('Cache-control', 'no-cache');
    }
    request.responseType = 'document';

    let doc = await Promise.race([
        xhrPromise(request).catch(() => undefined),
        wait(DEFAULT_TIMEOUT),
    ]);
    if(!doc) {
        console.error("failed to fetch", url);
        return;
    }

    if(doc.documentElement.localName === 'parseerror') {
        console.error("failed to parse as XML", url);
        return;
    }

    let result = parseFeed(doc, url);

    if(!result || !result.items || !(result.items.length > 0)) {
        console.warn("failed to find any items in", url);
    } else {
        let item = result.items[0];
        if(!item.published && !item.updated) {
            console.warn('no timestamps in', item);
        }
    }
    return result;
}

