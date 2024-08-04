// Originally based on code by Christopher Finke, "OPML Support" extension. Used with permisson.
import {Comm, expectedEvent} from "./utils.js";

/**
 * @typedef {import("/modules/database.js").Feed} Feed
 */

/**
 * @typedef {{url: string, siteURL: string, title: string}} ImportedFeed
 *
 * @typedef {object} ImportedFolder
 * @property {string} title
 * @property {ImportedNode[]} children
 *
 * @typedef {ImportedFeed | ImportedFolder} ImportedNode
 */

/**
 * @param {File} file
 */
export async function parseOPMLFile(file) {
    let reader = new FileReader();
    reader.readAsText(file); // assumes UTF-8
    await expectedEvent(reader, 'load');
    let results;

    try {
        results = parse(/** @type {string} */(reader.result));
    } catch(e) {
        window.alert(browser.i18n.getMessage('invalidFileAlertText'));
        return;
    }

    if(Comm.verbose) {
        console.log(results);
    }
    return results;
}

/**
 * @param {string} text
 */
export function parse(text) {
    let parser = new DOMParser();
    let doc = parser.parseFromString(text, 'application/xml');

    if (doc.documentElement.localName == 'parsererror') {
        throw new Error("OPML failed to parse as XML");
    }

    return Array.from(doc.getElementsByTagName('body')[0].children)
        .filter(c => c.nodeName === 'outline')
        .map(c => importNode(c))
        .filter(c => c !== undefined);
}

/**
 * @param {Element} node
 * @return {ImportedNode}
 */
function importNode(node) {
    // The standard requires 'text' to be always present, but sometimes that's not the case
    let title = node.getAttribute('text') || node.getAttribute('title');

    if(node.hasAttribute('xmlUrl') && node.getAttribute('type') !== 'link') {
        return {
            title,
            url: node.getAttribute('xmlUrl'),
            siteURL: node.getAttribute('htmlUrl'),
        };
    }

    if (node.childNodes.length > 0) {
        return {
            title,
            children: Array.from(node.children)
                .filter(c => c.nodeName === 'outline')
                .map(c => importNode(c))
                .filter(c => c !== undefined),
        };
    }
}

/**
 * @param {Feed[]} feeds
 */
export function serialize(feeds) {
    let data = '';
    data += '<?xml version="1.0" encoding="UTF-8"?>\n';
    data += '<opml version="1.0">\n';
    data += '\t<head>\n';
    data += '\t\t<title>Feeds OPML Export</title>\n';
    data += `\t\t<dateCreated>${new Date().toString()}</dateCreated>\n`;
    data += '\t</head>\n';
    data += '\t<body>\n';

    // The feeds are assumed to be sorted in tree order
    let parents = [feeds[0].parent]; //It's not in the list
    let indent = () => '\t'.repeat(parents.length + 1);
    for(let node of feeds) {
        while(parents[parents.length - 1] !== node.parent) {
            parents.pop();
            data += `${indent()}</outline>\n`;
            if(parents.length === 0) {
                console.error("incorrect database");
                return;
            }
        }
        let title = cleanXMLText(node.title);
        if(node.isFolder) {
            data += `${indent()}<outline text="${title}">\n`;
            parents.push(node.feedID);
        } else {
            data += `${indent()}<outline text="${title}" type="rss" version="RSS"` +
                    (node.websiteURL != null ? ` htmlUrl="${cleanXMLText(node.websiteURL)}"` : "") +
                    ` xmlUrl="${cleanXMLText(node.feedURL)}"/>\n`;
        }
    }
    while(parents.length > 1) {
        parents.pop();
        data += `${indent()}</outline>\n`;
    }

    data += '\t</body>\n';
    data += '</opml>';
    return data;
}

export async function exportFeeds(feeds) {
    let data = serialize(feeds.filter(f => !f.hidden));

    let blob = new Blob([data], {type: 'text/xml'});
    let url = URL.createObjectURL(blob);

    await browser.downloads.download({url, filename: 'feedlist.opml', saveAs: true});
}

/** @param {string} str */
function cleanXMLText(str) {
    let characters = [
        {find : '&', replace : '&amp;'},
        {find : '"', replace : '&quot;'},
        {find : "'", replace : '&apos;'},
        {find : '<', replace : '&lt;'},
        {find : '>', replace : '&gt;'}
    ];

    for (let ch of characters)
        str = str.replace(new RegExp(ch.find, 'g'), ch.replace);

    return str;
}
