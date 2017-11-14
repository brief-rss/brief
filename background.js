'use strict';

const Brief = {
    // Port for receiving status updates
    _statusPort: null,
    // Latest status
    _status: null,

    // No deinit required, we'll be forcefully unloaded anyway
    init: async function() {
        NotificationCenter.init();

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
        //FIXME: update UI on db changes

        await Database.init();

        this._updateUI();
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
        //browser.browserAction.setTitle({title: tooltip});
    },
};

Brief.init();
