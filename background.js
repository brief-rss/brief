'use strict';

const Brief = {
    // Port for receiving status updates
    _statusPort: null,
    // Latest status
    _status: null,

    // No deinit required, we'll be forcefully unloaded anyway
    init: async function() {
        Comm.initMaster();

        browser.browserAction.onClicked.addListener(
            () => browser.tabs.create({url: '/ui/brief.xhtml'}));
        browser.browserAction.setBadgeBackgroundColor({color: 'grey'});

        browser.contextMenus.create({
            id: "brief-button-refresh",
            title: browser.i18n.getMessage("briefCtxRefreshFeeds_label"),
            contexts: ["browser_action"]
        });
        browser.contextMenus.create({
            id: "brief-button-mark-read",
            title: browser.i18n.getMessage("briefCtxMarkFeedsAsRead_label"),
            contexts: ["browser_action"]
        });
        browser.contextMenus.create({
            id: "brief-button-show-unread",
            type: "checkbox",
            title: browser.i18n.getMessage("briefCtxShowUnreadCounter_label"),
            contexts: ["browser_action"]
        });
        browser.contextMenus.create({
            id: "brief-button-options",
            title: browser.i18n.getMessage("briefCtxShowOptions_label"),
            contexts: ["browser_action"]
        });
        browser.contextMenus.onClicked.addListener(info => this.onContext(info));

        await Prefs.init({master: true});

        Prefs.addObserver('showUnreadCounter', () => this._updateUI());
        Comm.registerObservers({
            'feedlist-updated': () => this._updateUI(),
            'entries-updated': () => this._updateUI(), //TODO: there was a debounce here...
        });

        await Database.init();

        await FeedUpdater.init();

        this._updateUI();
        // TODO: first run page
    },

    onContext: function({menuItemId, checked}) {
        switch(menuItemId) {
            case 'brief-button-refresh':
                browser.runtime.sendMessage({id: 'refresh'});
                break;
            case 'brief-button-mark-read':
                browser.runtime.sendMessage({id: 'mark-all-read'});
                break;
            case 'brief-button-show-unread':
                Prefs.set('showUnreadCounter', checked);
                break;
            case 'brief-button-options':
                browser.runtime.sendMessage({id: 'open-options'});
                break;
        }
    },

    _updateUI: async function() {

        let enabled = Prefs.get('showUnreadCounter');
        browser.contextMenus.update('brief-button-show-unread', {checked: enabled});
        if(enabled) {
            let count = await Database.query({deleted: 0, read: 0}).count();
            let text = "test";
            if(count > 0) {
                text = count.toString();
                // We crop the badge manually to leave the least-significant digits
                if (text.length > 4)
                    text = '..' + text.substring(text.length - 3);
            }
            browser.browserAction.setBadgeText({text});
        } else {
            browser.browserAction.setBadgeText({text: ""});
        }
        //TODO: return tooltip
        /*
            _updateStatus: async function Brief__updateStatus() {
                let updated = "";
                let bundle = Services.strings.createBundle('chrome://brief/locale/brief.properties');

                let lastUpdateTime = this.prefs.getIntPref('update.lastUpdateTime') * 1000;
                let date = new Date(lastUpdateTime);
                let relativeDate = new this.common.RelativeDate(lastUpdateTime);

                let time, pluralForms, form;
                let lang = Brief.window.navigator.language;

                switch (true) {
                    case relativeDate.deltaMinutes === 0:
                        updated = bundle.GetStringFromName('lastUpdated.rightNow');
                        break;

                    case relativeDate.deltaHours === 0:
                        pluralForms = bundle.GetStringFromName('minute.pluralForms');
                        form = this.common.getPluralForm(relativeDate.deltaMinutes, pluralForms);
                        updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                            .replace('#number', relativeDate.deltaMinutes);
                        break;

                    case relativeDate.deltaHours <= 12:
                        pluralForms = bundle.GetStringFromName('hour.pluralForms');
                        form = this.common.getPluralForm(relativeDate.deltaHours, pluralForms);
                        updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                            .replace('#number', relativeDate.deltaHours);
                        break;

                    case relativeDate.deltaDaySteps === 0:
                        time = date.toLocaleTimeString(lang, {hour: 'numeric', minute: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.today', [time], 1);
                        break;

                    case relativeDate.deltaDaySteps === 1:
                        time = date.toLocaleTimeString(lang, {hour: 'numeric', minute: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.yesterday', [time], 1);
                        break;

                    case relativeDate.deltaDaySteps < 7:
                        pluralForms = bundle.GetStringFromName('day.pluralForms');
                        form = this.common.getPluralForm(relativeDate.deltaDays, pluralForms);
                        updated = bundle.formatStringFromName('lastUpdated.ago', [form], 1)
                                            .replace('#number', relativeDate.deltaDays);
                        break;

                    case relativeDate.deltaYearSteps === 0:
                        date = date.toLocaleDateString(lang, {month: 'long', day: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.fullDate', [date], 1);
                        break;

                    default:
                        date = date.toLocaleDateString(lang, {
                            year: 'numeric', month: 'long', day: 'numeric'});
                        updated = bundle.formatStringFromName('lastUpdated.fullDate', [date], 1);
                        break;
                }

                let rows = [];

                let feeds_query = new Query({
                    deleted: false,
                    read: false,
                    sortOrder: 'library',
                    sortDirection: 'asc'
                })

                let unreadFeeds = await feeds_query.getProperty('feedID', true);

                let noUnreadText = "";
                if(unreadFeeds.length == 0)
                    noUnreadText = bundle.GetStringFromName('noUnreadFeedsTooltip');

                for (let feed of unreadFeeds) {
                    let feedName = Storage.getFeed(feed).title;
                    if(feedName.length > 24)
                        feedName = feedName.substring(0, 24) + "...";

                    let query = new Query({
                        deleted: false,
                        feeds: [feed],
                        read: false
                    })

                    rows.push(query.getEntryCount().then(count => `${count}\t\t${feedName}`));
                }
                rows = await Promise.all(rows);
                let tooltip = `${updated}\n\n${noUnreadText}${rows.join('\n')}`;
            },
         */
        //browser.browserAction.setTitle({title: tooltip});
    },
};

Brief.init();
