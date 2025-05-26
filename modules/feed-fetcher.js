//@ts-strict
import {parseFeed} from "./feed-parser.js";
import {wait, xhrPromise, cleanEntities} from "./utils.js";

const DEFAULT_TIMEOUT = 25000; // Default fetch timeout

/**
 * @param {URL | string | {feedURL: URL | string}} feed
 */
export async function fetchFeed(feed, {allow_cached = false} = {}) {
    let url = ((typeof feed === 'string') || (feed instanceof URL))  ? feed: feed.feedURL;
    let request = new XMLHttpRequest();
    request.open('GET', url);
    request.overrideMimeType('application/xml');
    if(!allow_cached) {
        request.setRequestHeader('Cache-control', 'no-cache');
    }
    request.responseType = '';

    let doc = await Promise.race([
        xhrPromise(request).catch(() => undefined),
        wait(DEFAULT_TIMEOUT),
    ]);

    if(!doc && request.status === 200) {
        doc = cleanEntities(request.responseText);
    }

    if(!doc || doc.documentElement.localName === 'parsererror') {
        console.error("failed to parse as XML", url);
        return;
    }

    let result = parseFeed(doc, new URL(url));

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
