import {Comm} from "./utils.js";

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

function parseNode(node, properties) {
    let props = {};
    let propPrios = new Map();
    let keyMap = buildKeyMap(properties);
    //TODO: handle attributes
    let children = Array.from(node.children);
    children.push(...node.attributes);
    for(let child of children) {
        let namespace = nsPrefix(child.namespaceURI);
        if(namespace === 'IGNORE:') {
            continue;
        } else if(namespace && namespace[0] === '[') {
            if(Comm.verbose) {
                console.log('unknown namespace', namespace, child);
            }
            continue;
        }
        let nodeKey = namespace + child.localName;
        let destinations = keyMap.get(nodeKey);
        if(destinations === undefined) {
            if(Comm.verbose) {
                console.log('unknown key', nodeKey, 'in', node);
            }
            continue;
        }
        for(let {name, type, array, prio} of destinations) {
            if(name === 'IGNORE') {
                continue;
            }
            let handler = HANDLERS[type];
            if(handler) {
                let value = handler(child);
                if(value === undefined || value === null) {
                    continue;
                }
                if(name === '{merge}') {
                    Object.assign(props, value);
                    continue;
                }
                if(array) {
                    if(props[name] === undefined) {
                        props[name] = [];
                    }
                    props[name].push(value);
                } else {
                    let prevPrio = propPrios.get(name) || 1000;
                    if(prio >= prevPrio) {
                        continue;
                    }
                    propPrios.set(name, prio);
                    props[name] = value;
                }
            } else {
                console.error('missing handler', type);
            }
        }
    }
    return props;
}

function buildKeyMap(known_properties) {
    let map = new Map();
    let prios = new Map();
    for(let [name, type, tags] of known_properties) {
        let array = false;
        if(name.slice(name.length - 2) === '[]') {
            name = name.slice(0, name.length - 2);
            array = true;
        }
        let prio = prios.get(name) || 1;

        for(let src of tags) {
            if(src.tag !== undefined) {
                type = src.type || type;
                src = src.tag;
            }
            let destinations = map.get(src) || [];
            destinations.push({name, type, array, prio});
            map.set(src, destinations);
            prio += 1;
            prios.set(name, prio);
        }
    }
    return map;
}

const HANDLERS = {
    entry(node) {
        const ENTRY_PROPERTIES = [
            ['title', 'text', ["title", "rss1:title", "atom03:title", "atom:title"]],
            ['link', 'url', ["link", "rss1:link"]],
            ['link', 'atomLinkAlternate', ["atom:link", "atom03:link"]],
            ['link', 'permaLink', ["guid", "rss1:guid"]],
            ['id', 'id', ["guid", "rss1:guid", "rdf:about", "atom03:id", "atom:id"]],
            ['authors[]', 'author', [
                "author", "rss1:author", "dc:creator", "dc:author", "atom03:author", "atom:author"
            ]],
            ['summary', 'text_or_xhtml', [
                "description", "rss1:description", "dc:description",
                "atom03:summary", "atom:summary"
            ]],
            ['content', 'text_or_xhtml', ["content:encoded", "atom03:content", "atom:content"]],
            ['published', 'date', [
                "pubDate", "rss1:pubDate", "atom03:issued", "dcterms:issued", "atom:published"
            ]],
            ['updated', 'date', [
                "pubDate", "rss1:pubDate", "atom03:modified",
                "dc:date", "dcterms:modified", "atom:updated"
            ]],
            //and others Brief does not use anyway...
            ['IGNORE', '', [
                "atom:category", "atom03:category", "category", "rss1:category",
                "comments", "wfw:commentRss", "rss1:comments",
                "dc:language", "dc:format", "xml:lang", "dc:subject",
                "enclosure", "dc:identifier"
            ]],
            // TODO: should these really be all ignored?
        ];
        let props = parseNode(node, ENTRY_PROPERTIES);
        return props;
    },

    feed(node) {
        const FEED_PROPERTIES = [
            // Name, handler name, list of known direct children with it
            ['title', 'text', ["title", "rss1:title", "atom03:title", "atom:title"]],
            ['subtitle', 'text', [
                "description", "dc:description", "rss1:description", "atom03:tagline", "atom:subtitle"
            ]],
            ['link', 'url', ["link", "rss1:link"]],
            ['link', 'atomLinkAlternate', ["atom:link", "atom03:link"]],
            ['items[]', 'entry', ["item", "rss1:item", "atom:entry", "atom03:entry"]],
            ['generator', 'text', ["generator", "rss1:generator", "atom03:generator", "atom:generator"]],
            ['updated', 'date', [
                "pubDate", "rss1:pubDate", "lastBuildDate", "atom03:modified", "dc:date",
                "dcterms:modified", "atom:updated"
            ]],
            ['language', 'lang', ["language", "rss1:language", "xml:lang"]],

            ['{merge}', 'feed', ["rss1:channel"]],
            //and others Brief does not use anyway...
            //TODO: enclosures
            ['IGNORE', '', [
                "atom:id", "atom03:id", "atom:author", "atom03:author",
                "category", "atom:category", "rss1:items"
            ]],
        ];
        return parseNode(node, FEED_PROPERTIES);
    },

    text(nodeOrAttr) {
        if(nodeOrAttr.children !== undefined) {
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

    text_or_xhtml(node) {
        let type = node.getAttribute('type');
        switch(type) {
            case 'xhtml': {
                let children = Array.from(node.childNodes).filter(n => !isWhitespaceOrComment(n));
                if(children.length === 1 && children[0].localName === 'div') {
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

    lang(nodeOrAttr) {
        return HANDLERS.text(nodeOrAttr);
    },

    author(node) {
        const AUTHOR_PROPERTIES = [
            ['name', 'text', ["name", "atom:name", "atom03:name"]],
            ['IGNORE', '', ["atom:uri", "atom:email"]],
        ];
        if(node.children.length > 0) {
            return parseNode(node, AUTHOR_PROPERTIES);
        } else {
            return HANDLERS.text(node);
        }
    },

    url(node) {
        try {
            return new URL(node.textContent, node.baseURI);
        } catch(e) {
            console.warn('failed to parse URL', node.textContent, 'with base', node.baseURI);
        }
    },

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

    id(nodeOrAttr) {
        return HANDLERS.text(nodeOrAttr);
    },

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
const IGNORED_NAMESPACES = {
    "http://www.w3.org/2000/xmlns/": "XML namespace definition",
    "http://purl.org/rss/1.0/modules/slash/": "Slashdot engine specific",
    "http://purl.org/rss/1.0/modules/syndication/": "Aggregator publishing schedule", // TODO: maybe use it?
    "http://www.livejournal.org/rss/lj/1.0/": "Livejournal metadata",
    "http://rssnamespace.org/feedburner/ext/1.0": "Feedburner metadata",
    "https://www.livejournal.com": "LJ",
    "com-wordpress:feed-additions:1": "wordpress",
};
