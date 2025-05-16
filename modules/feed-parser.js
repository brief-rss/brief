//@ts-strict
import {Comm} from "./utils.js";

/**
 * @typedef {object} Author
 * @property {string} name
 */

/**
 * @typedef {object} Entry
 * @property {string} title
 * @property {URL} link
 * @property {string} id
 * @property {(Author | string)[]} authors // FIXME
 * @property {string} summary
 * @property {string} content
 * @property {string} published
 * @property {string} updated
 * TODO should I use Date for the above, maybe?
 */

/**
 * @typedef {object} Feed
 * @property {string} title
 * @property {string} subtitle
 * @property {URL} link
 * @property {Entry[]} items
 * @property {string} generator
 * @property {string} updated
 * @property {string} language
 */

/**
 * @param {Document} doc
 * @param {URL} url
 */
export function parseFeed(doc, url) {
    let root = doc.querySelector(ROOTS);
    if(root === null) {
        console.error("feed root element not found", url);
        return;
    }

    let result = HANDLERS.feed(root);
    result.language = result.language || doc.documentElement.getAttribute('xml:lang');
    return result;
}

const ROOTS = "RDF, channel, *|feed"; // See also related ROOTS in scan-for-feeds.js

/**
 * @param {Element | Attr} node
 */
function nodeShortName(node) {
    let namespace = nsPrefix(node.namespaceURI);
    return namespace + node.localName;
}

class NodeChildrenIndex {
    /**
     * @param {Element} node
     */
    constructor(node) {
        this.index = new Map();
        for(let c of [...node.children, ...node.attributes]) {
            let name = nodeShortName(c);
            let arr = this.index.get(name) || [];
            arr.push(c);
            this.index.set(name, arr);
        }
        this.used = new Set();
    }
    /**
     * @template T
     * @param {(node: Element | Attr) => T} handler
     * @param {string[]} candidates
     */
    getValue(handler, candidates) {
        // Working according to priority here, collisions may be fine in some cases
        let nodes = candidates.flatMap(name => {
            this.used.add(name);
            return this.index.get(name) ?? [];
        });
        for(let node of nodes) {
            let value = handler(node);
            if(value != null) {
                return value;
            }
        }
    }

    /**
     * @template T
     * @param {(node: Element | Attr) => T} handler
     * @param {string[]} candidates
     */
    getAllValues(handler, candidates) {
        // Working according to priority here, collisions may be fine in some cases
        let nodes = candidates.flatMap(name => {
            this.used.add(name);
            return this.index.get(name) ?? [];
        });
        return nodes.map(handler);
    }

    /**
     * @param {string[]} names
     */
    reportUnusedExcept(names) {
        if(Comm.verbose) {
            for(let key of this.index.keys()) {
                if(!this.used.has(key) && !names.includes(key)) {
                    console.log('unknown child', key);
                }
            }
        }
    }
}

const HANDLERS = {
    /**
     * @param {Element} node
     * @returns {Entry}
     */
    entry(node) {
        let index = new NodeChildrenIndex(node);
        let result = {
            title: index.getValue(HANDLERS.text, ["title", "rss1:title", "atom03:title", "atom:title"]),
            link: index.getValue(HANDLERS.url, ["link", "rss1:link"])
                ?? index.getValue(HANDLERS.atomLinkAlternate, ["atom:link", "atom03:link"])
                ?? index.getValue(HANDLERS.permaLink, ["guid", "rss1:guid"]),
            id: index.getValue(HANDLERS.id, ["guid", "rss1:guid", "rdf:about", "atom03:id", "atom:id"]),
            authors: index.getAllValues(HANDLERS.author, ["author", "rss1:author", "dc:creator", "dc:author", "atom03:author", "atom:author"]),
            summary: index.getValue(HANDLERS.text_or_xhtml, ["description", "rss1:description", "dc:description", "atom03:summary", "atom:summary"]),
            content: index.getValue(HANDLERS.text_or_xhtml, ["content:encoded", "atom03:content", "atom:content"]),
            published: index.getValue(HANDLERS.date, ["pubDate", "rss1:pubDate", "atom03:issued", "dcterms:issued", "atom:published"]),
            updated: index.getValue(HANDLERS.date, ["pubDate", "rss1:pubDate", "atom03:modified", "dc:date", "dcterms:modified", "atom:updated"]),
        };
        index.reportUnusedExcept([
            "atom:category", "atom03:category", "category", "rss1:category",
            "comments", "wfw:commentRss", "rss1:comments",
            "dc:language", "dc:format", "xml:lang", "dc:subject",
            "enclosure", "dc:identifier"
        ]);
        return result;
    },

    /**
     * @param {Element} node
     * @returns {Feed}
     */
    feed(node) {
        let index = new NodeChildrenIndex(node);
        let result = {
            title: index.getValue(HANDLERS.text, ["title", "rss1:title", "atom03:title", "atom:title"]),
            subtitle: index.getValue(HANDLERS.text, ["description", "dc:description", "rss1:description", "atom03:tagline", "atom:subtitle"]),
            link: index.getValue(HANDLERS.url, ["link", "rss1:link"])
                ?? index.getValue(HANDLERS.atomLinkAlternate, ["atom:link", "atom03:link"]),
            items: index.getAllValues(HANDLERS.entry, ["item", "rss1:item", "atom:entry", "atom03:entry"]),
            generator: index.getValue(HANDLERS.text, ["generator", "rss1:generator", "atom03:generator", "atom:generator"]),
            updated: index.getValue(HANDLERS.date, ["pubDate", "rss1:pubDate", "lastBuildDate", "atom03:modified", "dc:date", "dcterms:modified", "atom:updated"]),
            language: index.getValue(HANDLERS.lang, ["language", "rss1:language", "xml:lang"]),
            ...index.getValue(HANDLERS.feed, ["rss1:channel"]),
        };
        index.reportUnusedExcept(["atom:id", "atom03:id", "atom:author", "atom03:author", "category", "atom:category", "rss1:items"]);
        return result;
    },

    /**
     * @param {Element | Attr } nodeOrAttr
     * @returns {string}
     */
    text(nodeOrAttr) {
        if(nodeOrAttr instanceof Element) {
            for(let child of nodeOrAttr.childNodes) {
                switch(child.nodeType) {
                    case Node.TEXT_NODE:
                    case Node.CDATA_SECTION_NODE:
                        continue;
                    default:
                        console.warn('possibly raw html in', nodeOrAttr);
                        break;
                }
            }
            return nodeOrAttr.textContent.trim();
        } else {
            return nodeOrAttr.value.trim();
        }
    },

    /**
     * @param {Element} node
     * @returns {string}
     */
    text_or_xhtml(node) {
        let type = node.getAttribute('type');
        switch(type) {
            case 'xhtml': {
                let children = Array.from(node.childNodes).filter(n => !isWhitespaceOrComment(n));
                if(children.length === 1 && children[0] instanceof Element && children[0].localName === 'div') {
                    return children[0].innerHTML;
                } else {
                    console.error('type="xhtml" structure violated in', node);
                    return node.innerHTML;
                }
            }
            //TODO Atom spec also allows text/* (handled below), XML media types (direct)
            // and other media types (base64), but I've never seen these used in a feed
            case 'text': // fallthrough
            case 'html': // fallthrough
            case null:
                // TODO "MUST NOT contain child elements" (Atom 1.0) - consider validating
                return HANDLERS.text(node);
            default:
                console.warn('Unknown content type in a feed', type);
                return HANDLERS.text(node);
        }
    },

    /**
     * @param {Element | Attr } nodeOrAttr
     * @returns {string}
     */
    lang(nodeOrAttr) {
        return HANDLERS.text(nodeOrAttr);
    },

    /**
     * @param {Element} node
     * @returns {Author | string}
     */
    author(node) {
        if(node.children.length == 0) {
            return HANDLERS.text(node);
        }
        let index = new NodeChildrenIndex(node);
        let result = {
            name: index.getValue(HANDLERS.text, ["name", "atom:name", "atom03:name"]),
        };
        index.reportUnusedExcept(["atom:uri", "atom:email"]);
        return result;
    },

    /**
     * @param {Element} node
     * @returns {URL}
     */
    url(node) {
        try {
            return new URL(node.textContent, node.baseURI);
        } catch(e) {
            console.warn('failed to parse URL', node.textContent, 'with base', node.baseURI);
        }
    },

    /**
     * @param {Element} node
     * @returns {string}
     */
    date(node) {
        let text = node.textContent.trim();
        // Support for Z timezone marker for UTC (mb 682781)
        let date = new Date(text.replace(/z$/i, "-00:00"));
        if (!isNaN(date.getTime())) {
            return date.toUTCString();
        }
        console.warn('failed to parse date', text);
        return null;
    },

    /**
     * @param {Element | Attr } nodeOrAttr
     * @returns {string}
     */
    id(nodeOrAttr) {
        return HANDLERS.text(nodeOrAttr);
    },

    /**
     * @param {Element} node
     * @returns {URL}
     */
    atomLinkAlternate(node) {
        let rel = node.getAttribute('rel') || 'alternate';
        let known = ['alternate', 'http://www.iana.org/assignments/relation/alternate'];
        if(known.includes(rel)) {
            let text = node.getAttribute('href');
            let link;
            try {
                link = new URL(text, node.baseURI);
            } catch(e) {
                console.warn('failed to parse URL', text, 'with base', node.baseURI);
            }
            return link;
        }
    },

    /**
     * @param {Element} node
     * @returns {URL}
     */
    permaLink(node) {
        let isPermaLink = node.getAttribute('isPermaLink');
        if(!isPermaLink || isPermaLink.toLowerCase() !== 'false') {
            try {
                return new URL(node.textContent);
            } catch(e) {
                console.warn('failed to parse absolute URL from GUID', node.textContent);
            }
        }
    },
};

/**
 * @param {Node} node
 */
function isWhitespaceOrComment(node) {
    switch(node.nodeType) {
        case Node.TEXT_NODE: // fallthrough
        case Node.CDATA_SECTION_NODE:
            return node.textContent.trim() === '';
        case Node.COMMENT_NODE:
            return true;
        default:
            return false;
    }
}

/**
 * @param {string} uri
 */
function nsPrefix(uri) {
    uri = uri || "";
    if(IGNORED_NAMESPACES[uri]) {
        return "IGNORE:";
    }
    if (uri.toLowerCase().indexOf("http://backend.userland.com") == 0) {
        return "";
    }
    let prefix = NAMESPACES[uri];
    if(prefix === undefined) {
        prefix = `[${uri}]`;
    }
    if(prefix) {
        return prefix + ":";
    } else {
        return "";
    }
}

/**
 * @type {Object.<string, string>}
 */
const NAMESPACES = {
    "": "",
    "http://webns.net/mvcb/": "admin",
    "http://backend.userland.com/rss": "",
    "http://blogs.law.harvard.edu/tech/rss": "",
    "http://www.w3.org/2005/Atom": "atom",
    "http://purl.org/atom/ns#": "atom03",
    "http://purl.org/rss/1.0/modules/content/": "content",
    "http://purl.org/dc/elements/1.1/": "dc",
    "http://purl.org/dc/terms/": "dcterms",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf",
    "http://purl.org/rss/1.0/": "rss1",
    "http://my.netscape.com/rdf/simple/0.9/": "rss1",
    "http://wellformedweb.org/CommentAPI/": "wfw",
    "http://purl.org/rss/1.0/modules/wiki/": "wiki",
    "http://www.w3.org/XML/1998/namespace": "xml",
    "http://search.yahoo.com/mrss/": "media",
    "http://search.yahoo.com/mrss": "media",
};
/**
 * @type {Object.<string, string>}
 */
const IGNORED_NAMESPACES = {
    "http://www.w3.org/2000/xmlns/": "XML namespace definition",
    "http://purl.org/rss/1.0/modules/slash/": "Slashdot engine specific",
    "http://purl.org/rss/1.0/modules/syndication/": "Aggregator publishing schedule", // TODO: maybe use it?
    "http://www.livejournal.org/rss/lj/1.0/": "Livejournal metadata",
    "http://rssnamespace.org/feedburner/ext/1.0": "Feedburner metadata",
    "https://www.livejournal.com": "LJ",
    "com-wordpress:feed-additions:1": "wordpress",
};
