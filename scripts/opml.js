// Based on code by Christopher Finke, "OPML Support" extension. Used with permisson.
import {Database} from "/scripts/database.js";
import {Prefs} from "/scripts/prefs.js";
import {Comm, expectedEvent} from "/scripts/utils.js";


export async function importOPML(file) {
    let reader = new FileReader();
    reader.readAsText(file); // assumes UTF-8
    await expectedEvent(reader, 'load');
    let data = reader.result;

    let parser = new DOMParser();
    let doc = parser.parseFromString(data, 'application/xml');

    if (doc.documentElement.localName == 'parsererror') {
        window.alert(browser.i18n.getMessage('invalidFileAlertText'));
        return;
    }

    let results = Array.from(doc.getElementsByTagName('body')[0].childNodes)
        .filter(c => c.nodeName === 'outline')
        .map(c => importNode(c))
        .filter(c => c !== undefined);

    if(Comm.verbose) {
        console.log(results);
    }
    Database.addFeeds(results);
}

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
            children: Array.from(node.childNodes)
                .filter(c => c.nodeName === 'outline')
                .map(c => importNode(c))
                .filter(c => c !== undefined),
        };
    }
}

export async function exportFeeds() {
    let data = '';
    data += '<?xml version="1.0" encoding="UTF-8"?>\n';
    data += '<opml version="1.0">\n';
    data += '\t<head>\n';
    data += '\t\t<title>Feeds OPML Export</title>\n';
    data += `\t\t<dateCreated>${new Date().toString()}</dateCreated>\n`;
    data += '\t</head>\n';
    data += '\t<body>\n';

    let feeds = Database.feeds.filter(f => !f.hidden);
    // The feeds are already correctly sorted
    let parents = [String(Prefs.get('homeFolder'))]; //It's not in the list
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
            let feedURL = cleanXMLText(node.feedURL);
            let siteURL = cleanXMLText(node.websiteURL);
            data += `${indent()}<outline text="${title}" type="rss" version="RSS"` +
                    ` htmlUrl="${siteURL}" xmlUrl="${feedURL}"/>\n`;
        }
    }
    while(parents.length > 1) {
        parents.pop();
        data += `${indent()}</outline>\n`;
    }

    data += '\t</body>\n';
    data += '</opml>';
    let blob = new Blob([data], {type: 'text/xml'});
    let url = URL.createObjectURL(blob);

    await browser.downloads.download({url, filename: 'feedlist.opml', saveAs: true});
}

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
