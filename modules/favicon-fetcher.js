//@ts-strict
import {Comm, wait, xhrPromise} from "./utils.js";

const DEFAULT_TIMEOUT = 25000;

/**
 * @typedef {import("/modules/database.js").Database} Database
 */

/**
 * @param {{feed: {feedID: string, favicon: string}, db: Database}} _
 */
export async function updateFavicon({feed, db}) {
    if(Comm.verbose) {
        console.log("Brief: fetching favicon for", feed);
    }
    let updatedFeed = {
        feedID: feed.feedID,
        lastFaviconRefresh: Date.now(),
        favicon: await fetchFaviconAsURL(feed) || feed.favicon,
    };
    await db.modifyFeed(updatedFeed);
}

/**
 * @param {{feedID: string, websiteURL?: string}} feed
 */
export async function fetchFaviconAsURL(feed) {
    // Try, in order, to get a favicon from
    // 1. favicon.ico relative to the website URL
    // 2. the image specified in the document at the web site
    // 3. the image specified in the document at the web site origin
    let faviconHardcodedURL = await fetchFaviconHardcodedURL(feed);
    if(faviconHardcodedURL) {
        return faviconHardcodedURL;
    } else {
        let faviconWebsiteURL = await fetchFaviconWebsiteURL(feed);
        if(faviconWebsiteURL) {
            return faviconWebsiteURL;
        } else {
            let faviconOriginURL = await fetchFaviconOriginURL(feed);
            if(faviconOriginURL) {
                return faviconOriginURL;
            }
        }
    }
}

/**
 * @param {{feedID: string, websiteURL?: string?, title?: string?}} feed
 */
async function fetchFaviconHardcodedURL(feed) {
    if (!feed.websiteURL) {
        return;
    }

    // Use websiteURL instead of feedURL for resolving the favicon URL,
    // because many websites use services like Feedburner for generating their
    // feeds and we would get the Feedburner's favicon instead.
    let faviconURL = new URL('/favicon.ico', feed.websiteURL);

    let favicon = await fetchFaviconFromURL(feed, faviconURL);
    return favicon;
}

/**
 * @param {{feedID: string, websiteURL?: string, title?: string?}} feed
 */
async function fetchFaviconWebsiteURL(feed) {
    if (!feed.websiteURL) {
        return;
    }

    let url = feed.websiteURL;
    let doc = await fetchDocFromURL(url);

    let faviconURL = getFaviconURLFromDoc(feed, doc);
    if (!faviconURL) {
        return;
    }

    let favicon = await fetchFaviconFromURL(feed, faviconURL);
    return favicon;

}

/**
 * @param {{feedID: string, websiteURL?: string, title?: string?}} feed
 */
async function fetchFaviconOriginURL(feed) {
    if (!feed.websiteURL) {
        return;
    }
    let url = new URL(feed.websiteURL).origin;
    let doc = await fetchDocFromURL(url);

    let faviconURL = getFaviconURLFromDoc(feed, doc);
    if (!faviconURL) {
        return;
    }

    let favicon = await fetchFaviconFromURL(feed, faviconURL);
    return favicon;

}

/** @param {string?} url */
async function fetchDocFromURL(url) {
    if (!url) {
        return;
    }
    let websiteRequest = new XMLHttpRequest();
    websiteRequest.open('GET', url);
    websiteRequest.responseType = 'document';

    let doc = await Promise.race([
        xhrPromise(websiteRequest).catch(() => undefined),
        wait(DEFAULT_TIMEOUT),
    ]);
    return doc;
}

/**
 * @param {{title?: string?}} feed
 * @param {URL} faviconURL
 */
async function fetchFaviconFromURL(feed, faviconURL) {
    let response = await fetch(faviconURL, {redirect: 'follow'});

    if(!response.ok) {
        if(Comm.verbose) {
            console.log(
                "Brief: failed to resolve favicon for feed ",
                feed.title,
                " at",
                faviconURL.href);
        }
        return;
    }

    let blob = await response.blob();
    if(blob.size === 0) {
        if(Comm.verbose) {
            console.log(
                "Brief: no response body when fetching favicon for feed ",
                feed.title,
                " at ",
                faviconURL.href);
        }
        return;
    }

    let reader = new FileReader();
    let favicon = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = e => reject(e);
        reader.readAsDataURL(blob);
    });

    return favicon;
}

/**
 * @param {{title?: string?, websiteURL?: string}} feed
 * @param {Document} doc
 */

function getFaviconURLFromDoc(feed, doc) {
    if(!doc) {
        if(Comm.verbose) {
            console.log(
                "Brief: when attempting to locate favicon for ",
                feed.title,
                ", failed to fetch feed web site");
        }
        return;
    }

    if(doc.documentElement.localName === 'parseerror') {
        if(Comm.verbose) {
            console.log(
                "Brief: when attempting to locate favicon for ",
                feed.title,
                ", failed to parse web site");
        }
        return;
    }
    let linkElements = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
    if(!linkElements) {
        if(Comm.verbose) {
            console.log(
                "Brief: when attempting to locate favicon for ",
                feed.title,
                ", found no related link elements in web site");
        }
        return;
    }
    let href = linkElements.getAttribute("href");
    let faviconURL = href ? new URL(href, feed.websiteURL) : null;

    if(!faviconURL) {
        if(Comm.verbose) {
            console.log(
                "Brief: when attempting to locate favicon for ",
                feed.title,
                ", no favicon locations were found in the web site");
        }
        return;
    }

    return faviconURL;

}
