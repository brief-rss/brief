const gBrief = {

    BRIEF_URL: 'chrome://brief/content/brief.xul',
    BRIEF_FAVICON_URL: 'chrome://brief/skin/feed-icon-16x16.png',
    FIRST_RUN_PAGE_URL: 'chrome://brief/content/firstrun.xhtml',

    tab: null,  // Tab in which Brief is loaded

    get statusIcon gBrief_statusIcon() {
        delete this.statusIcon;
        return this.statusIcon = document.getElementById('brief-status');
    },

    get toolbarbutton gBrief_toolbarbutton() {
        delete this.toolbarbutton;
        return this.toolbarbutton = document.getElementById('brief-button');
    },

    get prefs gBrief_prefs() {
        delete this.prefs;
        return this.prefs = Cc['@mozilla.org/preferences-service;1'].
                            getService(Ci.nsIPrefService).
                            getBranch('extensions.brief.').
                            QueryInterface(Ci.nsIPrefBranch2);
    },

    get Storage gBrief_Storage() {
        var tempScope = {};
        Components.utils.import('resource://brief/Storage.jsm', tempScope);

        delete this.Storage;
        return this.Storage = tempScope.Storage;
    },

    get Query gBrief_Query() {
        let tempScope = {};
        Components.utils.import('resource://brief/Storage.jsm', tempScope);
        delete this.Query;
        return this.Query = tempScope.Query
    },

    get FeedUpdateService gBrief_FeedUpdateService() {
        var tempScope = {};
        Components.utils.import('resource://brief/FeedUpdateService.jsm', tempScope);

        delete this.FeedUpdateService;
        return this.FeedUpdateService = tempScope.FeedUpdateService;
    },


    open: function gBrief_open(aNewTab) {
        if (this.toolbarbutton)
            this.toolbarbutton.checked = true;

        // If Brief is already open then select the existing tab.
        if (this.tab)
            gBrowser.selectedTab = this.tab;
        else if (aNewTab)
            gBrowser.loadOneTab(this.BRIEF_URL, null, null, null, false, false);
        else
            gBrowser.loadURI(this.BRIEF_URL, null, null);
    },

    toggle: function gBrief_toggle() {
        if (this.tab == gBrowser.selectedTab)
            gBrowser.removeTab(this.tab);
        else
            gBrief.open(this.shouldOpenInNewTab());
    },

    shouldOpenInNewTab: function gBrief_shouldOpenInNewTab() {
        var openInNewTab = this.prefs.getBoolPref('openInNewTab');
        var isLoading = gBrowser.webProgress.isLoadingDocument;
        var isBlank = (gBrowser.currentURI.spec == 'about:blank');
        return openInNewTab && (!isBlank || isLoading);
    },


    doCommand: function gBrief_doCommand(aCommand) {
        if (gBrowser.currentURI.spec == this.BRIEF_URL) {
            let win = gBrowser.contentDocument.defaultView.wrappedJSObject;
            win.gCommands[aCommand]();
        }
    },


    markFeedsAsRead: function gBrief_markFeedsAsRead() {
        new this.Query().markEntriesRead(true);
    },

    showOptions: function cmd_showOptions() {
        var prefBranch = Cc['@mozilla.org/preferences-service;1'].
                         getService(Ci.nsIPrefBranch);
        var instantApply = prefBranch.getBoolPref('browser.preferences.instantApply');
        var features = 'chrome,titlebar,toolbar,centerscreen,resizable,';
        features += instantApply ? 'modal=no,dialog=no' : 'modal';

        window.openDialog('chrome://brief/content/options/options.xul', 'Brief options',
                          features);
    },


    updateStatuspanel: function gBrief_updateStatuspanel() {
        var counter = document.getElementById('brief-status-counter');
        var panel = document.getElementById('brief-status');

        var query = new gBrief.Query();
        query.deleted = gBrief.Storage.ENTRY_STATE_NORMAL;
        query.unread = true;
        var unreadEntriesCount = query.getEntryCount();

        counter.value = unreadEntriesCount;
        panel.setAttribute('unread', unreadEntriesCount > 0);
    },

    refreshProgressmeter: function gBrief_refreshProgressmeter() {
        var progressmeter = document.getElementById('brief-progressmeter');
        var progress = 100 * this.FeedUpdateService.completedFeedsCount /
                             this.FeedUpdateService.scheduledFeedsCount;
        progressmeter.value = progress;

        if (progress == 100)
            setTimeout(function() { progressmeter.hidden = true }, 500);
    },


    constructTooltip: function gBrief_constructTooltip(aEvent) {
        var bundle = document.getElementById('brief-bundle');
        var rows = document.getElementById('brief-tooltip-rows');
        var tooltip = aEvent.target;

        // Integer prefs are longs while Date is a long long.
        var now = Math.round(Date.now() / 1000);
        var lastUpdateTime = gBrief.prefs.getIntPref('update.lastUpdateTime');
        var elapsedTime = now - lastUpdateTime;
        var hours = Math.floor(elapsedTime / 3600);
        var minutes = Math.floor((elapsedTime - hours*3600) / 60);

        var label = document.getElementById('brief-tooltip-last-updated');
        if (hours > 1)
            label.value = bundle.getFormattedString('lastUpdatedWithHours', [hours, minutes]);
        else if (hours == 1)
            label.value = bundle.getFormattedString('lastUpdatedOneHour', [minutes]);
        else
            label.value = bundle.getFormattedString('lastUpdatedOnlyMinutes', [minutes]);

        while (rows.lastChild)
            rows.removeChild(rows.lastChild);

        var query = new this.Query()
        query.deleted = this.Storage.ENTRY_STATE_NORMAL;
        query.unread = true;
        query.sortOrder = query.SORT_BY_FEED_ROW_INDEX;
        query.sortDirection = query.SORT_ASCENDING;
        var unreadFeeds = query.getProperty('feedID', true).
                                map(function(e) e.feedID);

        var noUnreadLabel = document.getElementById('brief-tooltip-no-unread');
        var value = bundle.getString('noUnreadFeedsTooltip');
        noUnreadLabel.setAttribute('value', value);
        noUnreadLabel.hidden = unreadFeeds;

        for (var i = 0; unreadFeeds && i < unreadFeeds.length; i++) {
            var row = document.createElement('row');
            row.setAttribute('class', 'unread-feed-row');
            row = rows.appendChild(row);

            var feedName = this.Storage.getFeed(unreadFeeds[i]).title;
            label = document.createElement('label');
            label.setAttribute('class', 'unread-feed-name');
            label.setAttribute('crop', 'right');
            label.setAttribute('value', feedName);
            row.appendChild(label);

            var query = new this.Query;
            query.deleted = this.Storage.ENTRY_STATE_NORMAL;
            query.feeds = [unreadFeeds[i]];
            query.unread = true;
            var unreadCount = query.getEntryCount();
            label = document.createElement('label');
            label.setAttribute('class', 'unread-entries-count');
            label.setAttribute('value', unreadCount);
            row.appendChild(label);

            value = unreadCount > 1 ? bundle.getString('manyUnreadEntries')
                                    : bundle.getString('singleUnreadEntry');
            label = document.createElement('label');
            label.setAttribute('class', 'unread-entries-desc');
            label.setAttribute('value', value);
            row.appendChild(label);
        }
    },


    onBriefButtonClick: function gBrief_onBriefButtonClick(aEvent) {
        if (aEvent.button != 0 && aEvent.button != 1)
            return;

        // Clicking the toolbar button when Brief is open in current tab
        // "unpresses" it and closes Brief.
        if (aEvent.target.id == 'brief-button' && gBrowser.selectedTab == this.tab
            && aEvent.button == 0) {

            // Closing the last tab closes the application when tab bar is visible,
            // and is impossible when it is hidden. In either case, if Brief is the
            // last tab we have to add another one before closing it.
            if (gBrowser.tabContainer.childNodes.length == 1)
                gBrowser.addTab('about:blank', null, null, null, null, false);
            gBrowser.removeCurrentTab();
        }
        else if (aEvent.button == 1 || gBrief.shouldOpenInNewTab()) {
            gBrief.open(true);
        }
        else {
            gBrief.open(false);
        }
    },

    onTabLoad: function gBrief_onTabLoad(aEvent) {
        var targetDoc = aEvent.target;

        if (targetDoc && targetDoc.documentURI == gBrief.BRIEF_URL) {

            if (!gBrief.tab) {
                var targetBrowser = gBrowser.getBrowserForDocument(targetDoc);
                var tabs = gBrowser.mTabs;
                for (var i = 0; i < tabs.length; i++) {
                    if (tabs[i].linkedBrowser == targetBrowser) {
                        gBrief.tab = tabs[i];
                        break;
                    }
                }
            }

            gBrowser.setIcon(gBrief.tab, gBrief.BRIEF_FAVICON_URL);
            if (gBrief.toolbarbutton)
                gBrief.toolbarbutton.checked = (gBrowser.selectedTab == gBrief.tab);
        }

        else if (gBrief.tab && gBrief.tab.linkedBrowser.currentURI.spec != gBrief.BRIEF_URL) {
            gBrief.tab = null;
            if (gBrief.toolbarbutton)
                gBrief.toolbarbutton.checked = (gBrowser.selectedTab == gBrief.tab);
        }
    },

    onTabClose: function gBrief_onTabClose(aEvent) {
        if (aEvent.originalTarget == gBrief.tab)
            gBrief.tab = null;
    },

    onTabSelect: function gBrief_onTabSelect(aEvent) {
        if (gBrief.toolbarbutton)
            gBrief.toolbarbutton.checked = (aEvent.originalTarget == gBrief.tab);
    },

    handleEvent: function gBrief_handleEvent(aEvent) {
        switch (aEvent.type) {
        case 'load':
            window.removeEventListener('load', this, false);

            var firstRun = this.prefs.getBoolPref('firstRun');
            if (firstRun) {
                // The timeout is necessary to avoid adding the button while
                // initialization of various other stuff is still in progress because
                // changing content of the toolbar may interfere with that.
                setTimeout(this.onFirstRun, 0);
            }

            var showStatusIcon = this.prefs.getBoolPref('showStatusbarIcon');
            if (showStatusIcon) {
                this.statusIcon.hidden = false;
                this.updateStatuspanel();
            }

            // Observe changes to the feed database in order to keep
            // the statusbar icon up-to-date.
            var observerService = Cc['@mozilla.org/observer-service;1'].
                                  getService(Ci.nsIObserverService);
            observerService.addObserver(this, 'brief:feed-updated', false);
            observerService.addObserver(this, 'brief:invalidate-feedlist', false);
            observerService.addObserver(this, 'brief:entry-status-changed', false);
            observerService.addObserver(this, 'brief:feed-update-queued', false);
            observerService.addObserver(this, 'brief:feed-update-canceled', false);

            // Stores the tab in which Brief is loaded so we can ensure only
            // instance can be open at a time. This is an UI choice, not a technical
            // limitation.
            // These listeners are responsible for observing in which tab Brief is loaded
            // as well as for maintaining correct checked state of the toolbarbutton.
            gBrowser.addEventListener('TabClose', this.onTabClose, false);
            gBrowser.addEventListener('TabSelect', this.onTabSelect, false);
            gBrowser.addEventListener('pageshow', this.onTabLoad, false);

            this.prefs.addObserver('', this, false);
            this.Storage.addObserver(this);

            window.addEventListener('unload', this, false);
            break;

        case 'unload':
            this.prefs.removeObserver('', this);
            this.Storage.removeObserver(this);

            var observerService = Cc['@mozilla.org/observer-service;1'].
                                  getService(Ci.nsIObserverService);
            observerService.removeObserver(this, 'brief:feed-updated');
            observerService.removeObserver(this, 'brief:invalidate-feedlist');
            observerService.removeObserver(this, 'brief:feed-update-queued');
            observerService.removeObserver(this, 'brief:feed-update-canceled');
            break;
        }
    },


    observe: function gBrief_observe(aSubject, aTopic, aData) {
        switch (aTopic) {
        case 'brief:invalidate-feedlist':
            if (!this.statusIcon.hidden)
                this.updateStatuspanel();
            break;

        case 'nsPref:changed':
            if (aData == 'showStatusbarIcon') {
                var newValue = this.prefs.getBoolPref('showStatusbarIcon');
                var statusIcon = document.getElementById('brief-status');
                statusIcon.hidden = !newValue;
                if (newValue)
                    this.updateStatuspanel();
            }
            break;

        case 'brief:feed-update-queued':
            // Only show the progressmeter if Brief isn't opened in the currently
            // selected tab (no need to show two progressmeters on screen).
            if (this.FeedUpdateService.status == this.FeedUpdateService.NORMAL_UPDATING
                && this.FeedUpdateService.scheduledFeedsCount > 1
                && gBrowser.selectedTab != this.tab) {

                document.getElementById('brief-progressmeter').hidden = false;
                this.refreshProgressmeter();
            }
            break;

        case 'brief:feed-update-canceled':
            var progressmeter = document.getElementById('brief-progressmeter');
            progressmeter.hidden = true;
            break;

        case 'brief:feed-updated':
            this.refreshProgressmeter();
            break;
        }
    },


    onEntriesAdded: function gBrief_onEntriesAdded(aEntryList) {
        if (!this.statusIcon.hidden)
            setTimeout(this.updateStatuspanel, 0);
    },

    onEntriesUpdated: function gBrief_onEntriesUpdated(aEntryList) {
        if (!this.statusIcon.hidden)
            setTimeout(this.updateStatuspanel, 0);
    },

    onEntriesMarkedRead: function gBrief_onEntriesMarkedRead(aEntryList, aState) {
        if (!this.statusIcon.hidden)
            setTimeout(this.updateStatuspanel, 0);
    },

    onEntriesDeleted: function gBrief_onEntriesDeleted(aEntryList, aState) {
        if (!this.statusIcon.hidden && aEntryList.containsUnread())
            setTimeout(this.updateStatuspanel, 0);
    },

    onEntriesTagged: function() { },
    onEntriesStarred: function() { },


    onFirstRun: function gBrief_onFirstRun() {
        // Add the toolbar button to the Navigation Bar.
        var navbar = document.getElementById('nav-bar');
        var currentSet = navbar.currentSet;
        if (!currentSet.match('brief-button')) {
            let newset = currentSet.replace('urlbar-container,', 'brief-button,urlbar-container,');
            navbar.currentSet = newset;
            navbar.setAttribute('currentset', newset);
            document.persist('nav-bar', 'currentset');
            BrowserToolboxCustomizeDone(true);
        }

        // Create the default feeds folder.
        var name = Cc['@mozilla.org/intl/stringbundle;1'].
                     getService(Ci.nsIStringBundleService).
                     createBundle('chrome://brief/locale/brief.properties').
                     GetStringFromName('defaultFeedsFolderName');
        var bookmarks = Cc['@mozilla.org/browser/nav-bookmarks-service;1'].
                        getService(Ci.nsINavBookmarksService);
        var folderID = bookmarks.createFolder(bookmarks.bookmarksMenuFolder, name,
                                              bookmarks.DEFAULT_INDEX);
        gBrief.prefs.setIntPref('homeFolder', folderID);

        // Load the first run page.
        gBrowser.loadOneTab(gBrief.FIRST_RUN_PAGE_URL, {
            relatedToCurrent: false,
            inBackground: false
        });
        gBrief.prefs.setBoolPref('firstRun', false);
    },

    // Registers %profile%/chrome directory under a resource URI.
    registerCustomStyle: function gBrief_registerCustomStyle() {
        var ioService = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
        var resourceProtocolHandler = ioService.getProtocolHandler('resource').
                                                QueryInterface(Ci.nsIResProtocolHandler);
        if (!resourceProtocolHandler.hasSubstitution('profile-chrome-dir')) {
            let chromeDir = Cc['@mozilla.org/file/directory_service;1'].
                            getService(Ci.nsIProperties).
                            get('ProfD', Ci.nsIFile);
            chromeDir.append('chrome');
            let chromeDirURI = ioService.newFileURI(chromeDir);
            resourceProtocolHandler.setSubstitution('profile-chrome-dir', chromeDirURI);
        }
    },


    QueryInterface: function gBrief_QueryInterface(aIID) {
        if (aIID.equals(Ci.nsISupports) ||
            aIID.equals(Ci.nsIDOMEventListener)) {
            return this;
        }
        throw Components.results.NS_ERROR_NO_INTERFACE;
    }

}

window.addEventListener('load', gBrief, false);
gBrief.registerCustomStyle();
