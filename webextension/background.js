'use strict';

const Brief = {
    // Port for receiving status updates
    _statusPort: null,
    // Latest status
    _status: null,

    // No deinit required, we'll be forcefully unloaded anyway
    init: async function() {
        browser.browserAction.onClicked.addListener(
            () => browser.runtime.sendMessage({id: 'open-brief'}));
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

        await Prefs.init();

        Prefs.addObserver('showUnreadCounter', () => this._updateUI());
        this._statusPort = browser.runtime.connect({name: 'watch-status'});
        this._statusPort.onMessage.addListener(msg => this._updateUI(msg));
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

    _updateUI: async function(msg) {
        if(msg !== undefined)
            this._status = msg;
        let {count, tooltip} = this._status;

        let enabled = Prefs.get('showUnreadCounter');
        browser.contextMenus.update('brief-button-show-unread', {checked: enabled});
        if(enabled) {
            let text = "";
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
        browser.browserAction.setTitle({title: tooltip});
    },
};

Brief.init();
