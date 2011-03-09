const Brief = {

    FIRST_RUN_PAGE_URL: 'chrome://brief/content/firstrun.xhtml',
    RELEASE_NOTES_URL_PREFIX: 'http://brief.mozdev.org/versions/',

    BRIEF_URL: 'chrome://brief/content/brief.xul',
    BRIEF_FAVICON_URL: 'chrome://brief/skin/feed-icon-16x16.png',

    get statusCounter() document.getElementById('brief-status-counter'),

    get toolbarbutton() document.getElementById('brief-button'),

    get prefs() {
        delete this.prefs;
        return this.prefs = Services.prefs.getBranch('extensions.brief.')
                                          .QueryInterface(Ci.nsIPrefBranch2);
    },

    get storage() {
        let tempScope = {};
        Components.utils.import('resource://brief/Storage.jsm', tempScope);

        delete this.storage;
        return this.storage = tempScope.Storage;
    },

    get query() {
        let tempScope = {};
        Components.utils.import('resource://brief/Storage.jsm', tempScope);

        delete this.query;
        return this.query = tempScope.Query
    },

    open: function Brief_open(aInCurrentTab) {
        let loading = gBrowser.webProgress.isLoadingDocument;
        let blank = (gBrowser.currentURI.spec == 'about:blank');
        let briefTab = this.getBriefTab();

        if (briefTab)
            gBrowser.selectedTab = briefTab;
        else if (blank && !loading || aInCurrentTab)
            gBrowser.loadURI(this.BRIEF_URL, null, null);
        else
            gBrowser.loadOneTab(this.BRIEF_URL, { inBackground: false });
    },

    getBriefTab: function Brief_getBriefTab() {
        let tabs = gBrowser.tabs;
        for (let i = 0; i < tabs.length; i++) {
            if (gBrowser.getBrowserForTab(tabs[i]).currentURI.spec == this.BRIEF_URL)
                return tabs[i];
        }

        return null;
    },

    doCommand: function Brief_doCommand(aCommand) {
        if (gBrowser.currentURI.spec == this.BRIEF_URL) {
            let win = gBrowser.contentDocument.defaultView.wrappedJSObject;
            win.Commands[aCommand]();
        }
    },

    updateAllFeeds: function Brief_updateAllFeeds() {
        let tempScope = {};
        Components.utils.import('resource://brief/FeedUpdateService.jsm', tempScope);
        tempScope.FeedUpdateService.updateAllFeeds();
    },

    markFeedsAsRead: function Brief_markFeedsAsRead() {
        new this.query().markEntriesRead(true);
    },

    toggleUnreadCounter: function Brief_toggleUnreadCounter() {
        let menuitem = document.getElementById('brief-show-unread-counter');
        let checked = menuitem.getAttribute('checked') == 'true';
        Brief.prefs.setBoolPref('showUnreadCounter', !checked);
    },

    showOptions: function cmd_showOptions() {
        let instantApply = Services.prefs.getBoolPref('browser.preferences.instantApply');
        let features = 'chrome,titlebar,toolbar,centerscreen,resizable,';
        features += instantApply ? 'modal=no,dialog=no' : 'modal';

        window.openDialog('chrome://brief/content/options/options.xul', 'Brief options',
                          features);
    }

    onTabLoad: function Brief_onTabLoad(aEvent) {
        if (aEvent.target && aEvent.target.documentURI == Brief.BRIEF_URL)
            gBrowser.setIcon(Brief.getBriefTab(), Brief.BRIEF_FAVICON_URL);
    },

    onWindowLoad: function Brief_onWindowLoad(aEvent) {
        window.removeEventListener('load', arguments.callee, false);

        if (this.prefs.getBoolPref('firstRun')) {
            this.onFirstRun();
        }
        else {
            // If Brief has been updated, load the new version info page.
            AddonManager.getAddonByID('brief@mozdev.org', function(addon) {
                let prevVersion = this.prefs.getCharPref('lastVersion');

                if (Services.vc.compare(prevVersion, addon.version) < 0) {
                    let url = this.RELEASE_NOTES_URL_PREFIX + addon.version + '.html';
                    gBrowser.loadOneTab(url, { relatedToCurrent: false,
                                               inBackground: false });
                    this.prefs.setCharPref('lastVersion', addon.version);
                }
            }.bind(this))
        }

        if (this.toolbarbutton) {
            let showCounter = this.prefs.getBoolPref('showUnreadCounter');
            this.statusCounter.hidden = !showCounter;

            let menuitem = document.getElementById('brief-show-unread-counter');
            menuitem.setAttribute('checked', showCounter);

            // Because Brief's toolbarbutton doesn't use toolbarbutton's binding content,
            // we must manually set the label in "icons and text" toolbar mode.
            let label = this.toolbarbutton.getElementsByClassName('toolbarbutton-text')[0];
            label.value = this.toolbarbutton.label;
        }

        this.updateStatus();

        if (this.prefs.getBoolPref('hideChrome'))
            XULBrowserWindow.inContentWhitelist.push(this.BRIEF_URL);

        gBrowser.addEventListener('pageshow', this.onTabLoad, false);

        this.storage.addObserver(this);
        this.prefs.addObserver('', this.onPrefChanged, false);
        Services.obs.addObserver(this.refreshUI, 'brief:invalidate-feedlist', false);

        window.addEventListener('unload', this.onWindowUnload.bind(this), false);
    },

    onWindowUnload: function Brief_onWindowUnload(aEvent) {
        this.storage.removeObserver(this);
        this.prefs.removeObserver('', this.onPrefChanged);
        Services.obs.removeObserver(this.refreshUI, 'brief:invalidate-feedlist');
    },


    onPrefChanged: function Brief_onPrefChanged(aSubject, aTopic, aData) {
        if (aData == 'showUnreadCounter') {
            let newValue = Brief.prefs.getBoolPref('showUnreadCounter');
            Brief.statusCounter.hidden = !newValue;

            let menuitem = document.getElementById('brief-show-unread-counter');
            menuitem.setAttribute('checked', newValue);

            if (newValue)
                this.updateStatus();
        }
    },


    onEntriesAdded: function Brief_onEntriesAdded(aEntryList) {
        this.refreshUI();
    },

    onEntriesUpdated: function Brief_onEntriesUpdated(aEntryList) {
        this.refreshUI();
    },

    onEntriesMarkedRead: function Brief_onEntriesMarkedRead(aEntryList, aState) {
        this.refreshUI();
    },

    onEntriesDeleted: function Brief_onEntriesDeleted(aEntryList, aState) {
        this.refreshUI();
    },

    onEntriesTagged: function() { },
    onEntriesStarred: function() { },

    refreshUI: function Brief_refreshUI() {
        Brief.updateStatus();

        let tooltip = document.getElementById('brief-tooltip');
        if (tooltip.state == 'open' || tooltip.state == 'showing')
            Brief.constructTooltip();
    },

    updateStatus: function Brief_updateStatus() {
        if (!Brief.toolbarbutton || !Brief.prefs.getBoolPref('showUnreadCounter'))
            return;

        let query = new Brief.query({
            deleted: Brief.storage.ENTRY_STATE_NORMAL,
            read: false
        })

        query.getEntryCount(function(unreadEntriesCount) {
            Brief.statusCounter.value = unreadEntriesCount;
            Brief.statusCounter.hidden = (unreadEntriesCount == 0);
        })
    },


    constructTooltip: function Brief_constructTooltip() {
        let bundle = document.getElementById('brief-bundle');
        let rows = document.getElementById('brief-tooltip-rows');
        let tooltip = document.getElementById('brief-tooltip');

        // Integer prefs are longs while Date is a long long.
        let now = Math.round(Date.now() / 1000);
        let lastUpdateTime = Brief.prefs.getIntPref('update.lastUpdateTime');
        let elapsedTime = now - lastUpdateTime;
        let hours = Math.floor(elapsedTime / 3600);
        let minutes = Math.floor((elapsedTime - hours * 3600) / 60);

        let label = document.getElementById('brief-tooltip-last-updated');
        if (hours > 1)
            label.value = bundle.getFormattedString('lastUpdatedWithHours', [hours, minutes]);
        else if (hours == 1)
            label.value = bundle.getFormattedString('lastUpdatedOneHour', [minutes]);
        else
            label.value = bundle.getFormattedString('lastUpdatedOnlyMinutes', [minutes]);

        while (rows.lastChild)
            rows.removeChild(rows.lastChild);

        let query = new this.query({
            deleted: this.storage.ENTRY_STATE_NORMAL,
            read: false,
            sortOrder: this.query.SORT_BY_FEED_ROW_INDEX,
            sortDirection: this.query.SORT_ASCENDING
        })

        query.getProperty('feedID', true, function(unreadFeeds) {
            let noUnreadLabel = document.getElementById('brief-tooltip-no-unread');
            let value = bundle.getString('noUnreadFeedsTooltip');
            noUnreadLabel.setAttribute('value', value);
            noUnreadLabel.hidden = unreadFeeds.length;

            unreadFeeds.forEach(function(feed) {
                let row = document.createElement('row');
                row.setAttribute('class', 'unread-feed-row');
                row = rows.appendChild(row);

                let feedName = this.storage.getFeed(feed).title;
                let label = document.createElement('label');
                label.setAttribute('class', 'unread-feed-name');
                label.setAttribute('crop', 'right');
                label.setAttribute('value', feedName);
                row.appendChild(label);

                let query = new this.query({
                    deleted: this.storage.ENTRY_STATE_NORMAL,
                    feeds: [feed],
                    read: false
                })

                query.getEntryCount(function(unreadCount) {
                    let label = document.createElement('label');
                    label.setAttribute('class', 'unread-entries-count');
                    label.setAttribute('value', unreadCount);
                    row.appendChild(label);

                    let value = unreadCount > 1 ? bundle.getString('manyUnreadEntries')
                                                : bundle.getString('singleUnreadEntry');
                    label = document.createElement('label');
                    label.setAttribute('class', 'unread-entries-desc');
                    label.setAttribute('value', value);
                    row.appendChild(label);
                }.bind(this))
            }.bind(this))
        }.bind(this))
    },

    onFirstRun: function Brief_onFirstRun() {
        // Add the toolbar button at the end of the Navigation Bar.
        let navbar = document.getElementById('nav-bar');
        if (!navbar.currentSet.match('brief-button')) {
            navbar.insertItem('brief-button', null, null, false);
            navbar.setAttribute('currentset', navbar.currentSet);
            document.persist('nav-bar', 'currentset');
        }

        // Create the default feeds folder.
        let name = Services.strings.createBundle('chrome://brief/locale/brief.properties')
                                   .GetStringFromName('defaultFeedsFolderName');
        let bookmarks = PlacesUtils.bookmarks;
        let folderID = bookmarks.createFolder(bookmarks.bookmarksMenuFolder, name,
                                              bookmarks.DEFAULT_INDEX);
        this.prefs.setIntPref('homeFolder', folderID);

        // Load the first run page.
        setTimeout(function() {
            gBrowser.loadOneTab(Brief.FIRST_RUN_PAGE_URL, { relatedToCurrent: false,
                                                            inBackground: false      })
        }, 0)

        this.prefs.setBoolPref('firstRun', false);
    }

}

window.addEventListener('load', Brief.onWindowLoad.bind(Brief), false);
