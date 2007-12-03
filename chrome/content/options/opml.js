/**
 * Original code by Christopher Finke, "OPML Support" extension. Used with permisson.
 */

var opml = {

    init: function() {
        // Fx2Compat
        this.importLevel = gPlacesEnabled ? this.importLevelPlaces
                                          : this.importLevelRDF;
        this.addFolderToOPML = gPlacesEnabled ? this.addFolderToOPML_Places
                                              : this.addFolderToOPML_RDF;

        if (gPlacesEnabled) {
            this.historyService =   Cc['@mozilla.org/browser/nav-history-service;1'].
                                    getService(Ci.nsINavHistoryService);
            this.bookmarksService = Cc['@mozilla.org/browser/nav-bookmarks-service;1'].
                                    getService(Ci.nsINavBookmarksService);
            this.livemarkService =  Cc['@mozilla.org/browser/livemark-service;2'].
                                    getService(Ci.nsILivemarkService);
            this.ioService = Cc['@mozilla.org/network/io-service;1'].
                             getService(Ci.nsIIOService);
        }
    },

    importOPML: function() {
        var bundle = document.getElementById('options-bundle');

        var nsIFilePicker = Ci.nsIFilePicker;
        var fp = Cc['@mozilla.org/filepicker;1'].createInstance(nsIFilePicker);
        fp.appendFilter(bundle.getString('OPMLFiles'),'*.opml');
        fp.appendFilter(bundle.getString('XMLFiles'),'*.opml; *.xml; *.rdf; *.html; *.htm');
        fp.appendFilter(bundle.getString('allFiles'),'*');

        fp.init(window, bundle.getString('selectFile'), nsIFilePicker.modeOpen);

        var res = fp.show();

        if (res == nsIFilePicker.returnOK) {
            // Read any xml file by using XMLHttpRequest.
            // Any character code is converted to native unicode automatically.
            var fix = Cc['@mozilla.org/docshell/urifixup;1'].getService(Ci.nsIURIFixup);
            var url = fix.createFixupURI(fp.file.path, fix.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP);

            var reader = new XMLHttpRequest();
            reader.open('GET', url.spec, false);
            reader.overrideMimeType('application/xml');
            reader.send(null);
            var opmldoc = reader.responseXML;

            var results = [];

            // At this point, we have an XML doc in opmldoc
            var nodes = opmldoc.getElementsByTagName('body')[0].childNodes;

            for (var i = 0; i < nodes.length; i++) {
                if (nodes[i].nodeName == 'outline')
                    results = this.importNode(results, nodes[i]);
            }

            // Now we have the structure of the file in an array.
            var carr = {folders : 0, links : 0, feeds : 0};

            for (var i = 0; i < results.length; i++)
                carr = this.countItems(results[i], carr);

            this.importLevel(results, null);
        }
    },

    importLevelRDF: function(nodes, createIn) {
        if (!createIn) {
			var pref = document.getElementById('extensions.brief.liveBookmarksFolder');
            createIn = RDF.GetResource(pref.value || 'NC:BookmarksRoot');
        }

        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            switch (node.type) {
            case 'folder':
                var newCreateIn = BMSVC.createFolderInContainer(node.title, createIn, null);
                this.importLevel(node.children, newCreateIn);
                break;
            case 'feed':
                BMSVC.createLivemarkInContainer(node.title, node.url, node.feedURL,
                                                node.desc, createIn, null);
                break;
            case 'link':
                BMSVC.createBookmarkInContainer(node.title, node.url, node.keyword,
                                                node.desc, null, null, createIn, null);
                break;
            }
        }
    },

    importLevelPlaces: function(nodes, createIn) {
        if (!createIn) {
			var home = document.getElementById('extensions.brief.homeFolder').value;
            var createIn = home || this.bookmarksService.bookmarksMenuFolder;
        }

        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            switch (node.type) {
            case 'folder':
                var newCreateIn = this.bookmarksService.createFolder(createIn, node.title, -1);
                this.importLevel(node.children, newCreateIn);
                break;

            case 'feed':

                var siteURI = this.ioService.newURI(node.url, null, null);
                var feedURI = this.ioService.newURI(node.feedURL, null, null);
                this.livemarkService.createLivemark(createIn, node.title, siteURI,
                                                    feedURI, -1);
                break;

            case 'link':
                var uri = this.ioService.newURI(node.url, null, null);
                this.bookmarksService.insertBookmark(createIn, uri, -1, node.title);
                break;
            }
        }
    },

    countItems: function (arr, carr) {
        if (arr.type == 'folder') {
            carr.folders++;

            for (var i = 0; i < arr.children.length; i++)
                carr = this.countItems(arr.children[i], carr);
        }
        else if (arr.type == 'link') {
            carr.links++;
        }
        else if (arr.type == 'feed') {
            carr.feeds++;
        }

        return carr;
    },

    importNode: function(results, node) {
        var hash = {};
        hash.title = node.getAttribute('text');
        hash.keyword = '';

        if (node.childNodes.length > 0) {
            hash.type = 'folder';
            hash.children = [];

            var children = node.childNodes;

            for (var i = 0; i < children.length; i++) {
                if (children[i].nodeName == 'outline')
                    hash.children = this.importNode(hash.children, children[i]);
            }

            results.push(hash);
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

            results.push(hash);
        }

        return results;
    },

    exportOPML: function() {
        var filePrefix = 'feeds';
        var title = 'Feeds';

        var file = this.promptForFile(filePrefix);

        if (file) {
            // Fx2Compat
            if (gPlacesEnabled) {
                var home = document.getElementById('extensions.brief.homeFolder').value;
                var folder = home || this.bookmarksService.bookmarksMenuFolder;

                var options = this.historyService.getNewQueryOptions();
                var query = this.historyService.getNewQuery();

                query.setFolders([folder], 1);
                options.excludeItems = true;
                var result = this.historyService.executeQuery(query, options);
                var root = result.root;
            }
            else {
                var pref = document.getElementById('extensions.brief.liveBookmarksFolder');
                var root = RDF.GetResource(pref.value || 'NC:BookmarksRoot');
            }

            var data = '';
            data += '<?xml version="1.0" encoding="UTF-8"?>' + '\n';
            data += '<opml version="1.0">' + '\n';
            data += '\t' + '<head>' + '\n';
            data += '\t\t' + '<title>' + title + ' OPML Export</title>' + '\n';
            data += '\t\t' + '<dateCreated>' + new Date().toString() + '</dateCreated>' + '\n';
            data += '\t' + '</head>' + '\n';
            data += '\t' + '<body>' + '\n';

            data = this.addFolderToOPML(data, root, 0, true);

            data += '\t' + '</body>' + '\n';
            data += '</opml>';

            // convert to utf-8 from native unicode
            var converter = Cc['@mozilla.org/intl/scriptableunicodeconverter'].
                            getService(Ci.nsIScriptableUnicodeConverter);
            converter.charset = 'UTF-8';
            data = converter.ConvertFromUnicode(data);

            var outputStream = Cc['@mozilla.org/network/file-output-stream;1'].
                               createInstance(Ci.nsIFileOutputStream);

            outputStream.init(file, 0x04 | 0x08 | 0x20, 420, 0 );
            outputStream.write(data, data.length);
            outputStream.close();
        }
    },

    addFolderToOPML_RDF: function(dataString, folder, level, isBase) {
        level++;

        if (!isBase) {
            dataString += '\t';

            for (var i = 1; i < level; i++)
                dataString += '\t';

            var name = this.getField(folder, 'Name');
            dataString += '<outline text="' + this.cleanXMLText(name) + '">' + '\n';
        }

        RDFC.Init(BMDS, folder);

        var elements = RDFC.GetElements();

        while (elements.hasMoreElements()) {
            var element = elements.getNext();
            element.QueryInterface(Components.interfaces.nsIRDFResource);

            var type = BookmarksUtils.resolveType(element);

            if (type == 'Folder' || type == 'PersonalToolbarFolder') {
                dataString = this.addFolderToOPML(dataString, element, level, false);
            }
            else if (type == 'Livemark') {
                dataString += '\t\t';

                for (var i = 1; i < level; i++)
                    dataString += '\t';

                var name = this.getField(element, "Name");
                var url = this.getField(element, "URL");
                var feedURL = this.getField(element, "FeedURL");
                var desc = this.getField(element, "Description");

                dataString += '<outline type="rss" version="RSS" '           +
                              'text="'          + this.cleanXMLText(name)    +
                              '" htmlUrl="'     + this.cleanXMLText(url)     +
                              '" xmlUrl="'      + this.cleanXMLText(feedURL) +
                              '" description="' + this.cleanXMLText(desc)    +
                              '"/>' + "\n";
            }
        }

        if (!isBase) {
            dataString += '\t';

            for (var i = 1; i < level; i++)
                dataString += '\t';

            dataString += '</outline>' + '\n';
        }

        return dataString;
    },

    addFolderToOPML_Places: function(dataString, folder, level, isBase) {
        level++;

        if (!isBase) {
            dataString += '\t';

            for (var i = 1; i < level; i++)
                dataString += '\t';

            var name = this.bookmarksService.getItemTitle(folder.itemId);
            dataString += '<outline text="' + this.cleanXMLText(name) + '">' + '\n';
        }

        folder.containerOpen = true;

        for (var i = 0; i < folder.childCount; i++) {
            var node = folder.getChild(i);

            if (node.type != Ci.nsINavHistoryResultNode.RESULT_TYPE_FOLDER)
                continue;

            if (this.livemarkService.isLivemark(node.itemId)) {
                dataString += '\t\t';

                for (var j = 1; j < level; j++)
                    dataString += '\t';

                var name = this.bookmarksService.getItemTitle(node.itemId);
                var url = this.livemarkService.getSiteURI(node.itemId).spec;
                var feedURL = this.livemarkService.getFeedURI(node.itemId).spec

                dataString += '<outline type="rss" version="RSS" '           +
                              'text="'          + this.cleanXMLText(name)    +
                              '" htmlUrl="'     + this.cleanXMLText(url)     +
                              '" xmlUrl="'      + this.cleanXMLText(feedURL) +
                              '"/>' + "\n";
            }
            else if (node instanceof Ci.nsINavHistoryContainerResultNode) {
                dataString = this.addFolderToOPML(dataString, node, level, false);
            }
        }

        folder.containerOpen = false;

        if (!isBase) {
            dataString += '\t';

            for (var i = 1; i < level; i++)
                dataString += '\t';

            dataString += '</outline>' + '\n';
        }

        return dataString;
    },

    promptForFile: function (filePrefix) {
        var bundle = document.getElementById('options-bundle');

        var nsIFilePicker = Ci.nsIFilePicker;
        var fp = Cc['@mozilla.org/filepicker;1'].createInstance(nsIFilePicker);
        fp.init(window, bundle.getString('saveAs'), nsIFilePicker.modeSave);

        fp.appendFilter(bundle.getString('OPMLFiles'),'*.opml');
        fp.appendFilter(bundle.getString('XMLFiles'),'*.opml; *.xml; *.rdf; *.html; *.htm');
        fp.appendFilter(bundle.getString('allFiles'),'*');

        fp.defaultString = filePrefix + '.opml';

        var result = fp.show();

        if (result == nsIFilePicker.returnCancel)
            return false;
        else
            return fp.file;
    },

    cleanXMLText : function (str) {
        var res = [
            {find : '&', replace : '&amp;'},
            {find : '"', replace : '&quot;'},
            {find : '<', replace : '&lt;'},
            {find : '>', replace : '&gt;'}
        ];

        for (var i = 0; i < res.length; i++){
            var re = new RegExp(res[i].find, 'g');

            str = str.replace(re, res[i].replace);
        }

        return str;
    },

    getField : function (e, field) {
        try {
            var source = RDF.GetResource(e.Value);
            var property = RDF.GetResource('http://home.netscape.com/NC-rdf#'+field);
            return BMDS.GetTarget(source, property, true).
                        QueryInterface(kRDFLITIID).Value;
        }
        catch (e) {
            return '';
        }
    }
};