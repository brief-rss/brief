/**
 * Original code by Christopher Finke, "OPML Support" extension. Used with permisson.
 */

const EXPORTED_SYMBOLS = ['OPML'];

Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/Storage.jsm');
Components.utils.import('resource://gre/modules/PlacesUtils.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/Task.jsm');
Components.utils.import('resource://gre/modules/osfile.jsm');

IMPORT_COMMON(this);


let OPML = Object.freeze({

    importFile: function() {
        OPMLInternal.importOPML();
    },

    exportFeeds: function() {
        OPMLInternal.exportOPML();
    }

})


let OPMLInternal = {

    importOPML: function*() {
        let path = this.promptForFile('open');

        if (path) {
            let dataArray = yield OS.File.read(path);
            let string = new TextDecoder().decode(dataArray);
            let parser = Cc['@mozilla.org/xmlextras/domparser;1'].createInstance(Ci.nsIDOMParser);
            let opmldoc = parser.parseFromString(string, 'application/xml');

            if (opmldoc.documentElement.localName == 'parsererror') {
                Services.prompt.alert(win, bundle.GetStringFromName('invalidFileAlertTitle'),
                                      bundle.GetStringFromName('invalidFileAlertText'));
                return;
            }

            let results = [];

            // At this point, we have an XML doc in opmldoc
            for (let node of opmldoc.getElementsByTagName('body')[0].childNodes) {
                if (node.nodeName == 'outline')
                    results.push(this.importNode(node));
            }

            Storage.ensureHomeFolder();
            let homeFolder = Services.prefs.getIntPref('extensions.brief.homeFolder');
            let transactions = this.importLevel(results, homeFolder);

            let aggregatedTrans = new PlacesAggregatedTransaction('Import feeds',
                                                                  transactions);
            PlacesUtils.transactionManager.doTransaction(aggregatedTrans);
        }
    }.task(),

    importLevel: function(aNodes, aCreateIn) {
        let aTransactions = [];
        for (let node of aNodes) {
            switch (node.type) {
            case 'folder':
                let childItemsTransactions = this.importLevel(node.children, null);

                let trans = new PlacesCreateFolderTransaction(node.title, aCreateIn, -1,
                                                              null, childItemsTransactions);
                aTransactions.push(trans);
                break;

            case 'feed': {
                let siteURI = null, feedURI = null;

                try {
                     feedURI = Services.io.newURI(node.feedURL, null, null);
                }
                catch (ex) {
                    log('Brief\nFailed to import feed ' + node.title +
                        '\nInvalid URI: ' + node.feedURL);
                    break;
                }

                try {
                    siteURI = Services.io.newURI(node.url, null, null);
                }
                catch (ex) {
                    // We can live without siteURI.
                }

                let trans = new PlacesCreateLivemarkTransaction(feedURI, siteURI,
                                                            node.title, aCreateIn);
                aTransactions.push(trans)
                break;
            }

            case 'link':
                try {
                    var uri = Services.io.newURI(node.url, null, null);
                }
                catch (ex) {
                    break;
                }
                trans = new PlacesCreateBookmarkTransaction(uri, aCreateIn, -1, node.title);
                aTransactions.push(trans);
                break;
            }
        }
        return aTransactions;
    },

    importNode: function(node) {
        let hash = {};
        hash.title = node.getAttribute('text');
        hash.keyword = '';

        if (node.childNodes.length > 0 || (!node.hasAttribute('xmlUrl')
            && !node.hasAttribute('htmlUrl') && !node.hasAttribute('url'))) {

            hash.type = 'folder';
            hash.children = [];

            for (let child of node.childNodes) {
                if (child.nodeName == 'outline')
                    hash.children.push(this.importNode(child));
            }
        }
        else {
            if (node.getAttribute('type') == 'link') {
                hash.type = 'link';
                hash.url = node.getAttribute('url');
                hash.keyword = node.getAttribute('keyword');
            }
            else {
                hash.type = 'feed';
                hash.feedURL = node.getAttribute('xmlUrl');
                hash.url = node.getAttribute('htmlUrl');
            }

            hash.desc = node.getAttribute('description');
        }

        return hash;
    },

    exportOPML: function* exportOPML() {
        let path = this.promptForFile('save');

        if (path) {
            let folder = Services.prefs.getIntPref('extensions.brief.homeFolder');

            let options = PlacesUtils.history.getNewQueryOptions();
            let query = PlacesUtils.history.getNewQuery();
            query.setFolders([folder], 1);
            options.excludeItems = true;
            let result = PlacesUtils.history.executeQuery(query, options);

            let data = '';
            data += '<?xml version="1.0" encoding="UTF-8"?>' + '\n';
            data += '<opml version="1.0">' + '\n';
            data += '\t' + '<head>' + '\n';
            data += '\t\t' + '<title>' + 'Feeds OPML Export</title>' + '\n';
            data += '\t\t' + '<dateCreated>' + new Date().toString() + '</dateCreated>' + '\n';
            data += '\t' + '</head>' + '\n';
            data += '\t' + '<body>' + '\n';

            data = yield this.addFolderToOPML(data, result.root, 0, true);

            data += '\t' + '</body>' + '\n';
            data += '</opml>';

            let array = new TextEncoder().encode(data);
            OS.File.writeAtomic(path, array);
        }
    }.task(),


    addFolderToOPML: function* addFolderToOPML(dataString, folder, level, isBase) {
        level++;

        if (!isBase) {
            dataString += '\t'.repeat(level);
            let name = PlacesUtils.bookmarks.getItemTitle(folder.itemId);
            dataString += '<outline text="' + this.cleanXMLText(name) + '">' + '\n';
        }

        folder.containerOpen = true;

        for (let i = 0; i < folder.childCount; i++) {
            let node = folder.getChild(i);

            if (node.type != Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER)
                continue;

            try {
                let livemark = yield PlacesUtils.livemarks.getLivemark({ 'id': node.itemId });
                let name = PlacesUtils.bookmarks.getItemTitle(node.itemId);
                let feedURL = livemark.feedURI.spec;
                let siteURL = livemark.siteURI ? livemark.siteURI.spec : '';

                dataString += '\t'.repeat(level + 1);
                dataString += '<outline type="rss" version="RSS" '           +
                              'text="'          + this.cleanXMLText(name)    +
                              '" htmlUrl="'     + this.cleanXMLText(siteURL) +
                              '" xmlUrl="'      + this.cleanXMLText(feedURL) +
                              '"/>' + "\n";
            }
            // Since there's no livermarkExists() method, we have to differentiate
            // between livermarks and folders by catching an exception.
            catch (ex if "result" in ex && ex.result == Components.results.NS_ERROR_INVALID_ARG) {
                if (node instanceof Ci.nsINavHistoryContainerResultNode)
                    dataString = yield this.addFolderToOPML(dataString, node, level, false);
            }
        }

        folder.containerOpen = false;

        if (!isBase) {
            dataString += '\t'.repeat(level);
            dataString += '</outline>' + '\n';
        }

        return dataString;
    }.task(),

    promptForFile: function(aMode) {
        let bundle = Services.strings.createBundle('chrome://brief/locale/options.properties');
        let win = Cc['@mozilla.org/appshell/window-mediator;1'].getService(Ci.nsIWindowMediator)
                                                               .getMostRecentWindow(null);
        let fp = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);

        fp.appendFilter(bundle.GetStringFromName('OPMLFiles'),'*.opml');
        fp.appendFilter(bundle.GetStringFromName('XMLFiles'),'*.opml; *.xml; *.rdf; *.html; *.htm');
        fp.appendFilter(bundle.GetStringFromName('allFiles'),'*');

        if (aMode == 'save') {
            fp.defaultString = 'feeds.opml';
            fp.init(win, bundle.GetStringFromName('saveAs'), Ci.nsIFilePicker.modeSave);
        }
        else {
            fp.init(win, bundle.GetStringFromName('selectFile'), Ci.nsIFilePicker.modeOpen);
        }

        let result = fp.show();

        return result == Ci.nsIFilePicker.returnCancel ? null : fp.file.path;
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
