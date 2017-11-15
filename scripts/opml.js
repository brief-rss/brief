'use strict';
// Based on code by Christopher Finke, "OPML Support" extension. Used with permisson.

let OPML = {

    async exportFeeds() {
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
        for(let node of feeds) {
            let indent = () => '\t'.repeat(parents.length + 1);
            while(parents[parents.length - 1] !== node.parent) {
                parents.pop();
                data += `${indent()}</outline>\n`;
                if(parents.length === 0) {
                    console.error("incorrect database");
                    return;
                }
            }
            let title = this.cleanXMLText(node.title);
            if(node.isFolder) {
                data += `${indent()}<outline text="${title}">\n`;
                parents.push(node.feedID);
            } else {
                let feedURL = this.cleanXMLText(node.feedURL);
                let siteURL = this.cleanXMLText(node.websiteURL);
                data += `${indent()}<outline text="${title}" type="rss" version="RSS"` +
                        ` htmlUrl="${siteURL}" xmlUrl="${feedURL}"/>\n`;
            }
        }

        data += '\t</body>\n';
        data += '</opml>';
        let blob = new Blob([data], {type: 'text/xml'});
        let url = URL.createObjectURL(blob);

        await browser.downloads.download({url, filename: 'feedlist.opml', saveAs: true});
    },

    cleanXMLText: function(str) {
        let characters = [
            {find : '&', replace : '&amp;'},
            {find : '"', replace : '&quot;'},
            {find : '<', replace : '&lt;'},
            {find : '>', replace : '&gt;'}
        ]

        for (let ch of characters)
            str = str.replace(new RegExp(ch.find, 'g'), ch.replace);

        return str;
    }

}
