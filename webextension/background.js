'use strict';

const Brief = {
    port: null,
    prefs: {
        showUnreadCount: false,
    },

    // No deinit required, we'll be forcefully unloaded anyway
    init: function() {
        this.port = browser.runtime.connect({name: 'we-to-legacy'});
        this.port.onMessage.addListener(message => this.onMessage(message));

        browser.browserAction.onClicked.addListener(() => this.openBrief());
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

        this.port.postMessage({id: 'get-show-unread-counter'});
    },

    onContext: function({menuItemId, checked}) {
        switch(menuItemId) {
            case 'brief-button-refresh':
                this.port.postMessage({id: 'refresh'});
                break;
            case 'brief-button-mark-read':
                this.port.postMessage({id: 'mark-all-read'});
                break;
            case 'brief-button-show-unread':
                this.port.postMessage({id: 'set-show-unread-counter', state: checked});
                break;
            case 'brief-button-options':
                this.port.postMessage({id: 'open-options'});
                break;
        }
    },

    onMessage: function(message) {
        switch(message.id) {
            case 'set-show-unread-counter':
                let {state} = message;
                this.prefs.showUnreadCounter = state;
                browser.contextMenus.update('brief-button-show-unread', {checked: state});
                if(state) {
                    this.port.postMessage({id: 'get-summary'});
                } else {
                    browser.browserAction.setBadgeText({text: ""});
                }
                break;
            case 'set-unread-count': {
                let {count} = message;
                let text = "";
                if(this.prefs.showUnreadCounter && count > 0) {
                    text = count.toString();
                    // We crop the badge manually to leave the least-significant digits
                    if (text.length > 4)
                        text = '..' + text.substring(text.length - 3);
                }
                browser.browserAction.setBadgeText({text});
                break;
            }
            case 'set-tooltip': {
                let {text} = message;
                browser.browserAction.setTitle({title: text});
                break;
            }
            default:
                console.log("Unknown command " + message.id);
        }
    },

    openBrief: function() {
        this.port.postMessage({id: 'open-brief'});
    },
};

Brief.init();
