Components.utils.import('resource://brief/common.jsm');
Components.utils.import('resource://brief/FeedUpdateService.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import('resource://gre/modules/NetUtil.jsm');

IMPORT_COMMON(this);

const SUBSCRIBE_PREFIX = 'brief://subscribe/';

/**
 * This is a protocol handler for our custom brief:// protocol,
 * which we use to register a content handler for feeds.
 */
function BriefProtocolHandler() { }

BriefProtocolHandler.prototype = {

    // nsIProtocolHandler
    scheme: 'brief',

    // nsIProtocolHandler
    defaultPort: -1,

    // nsIProtocolHandler
    protocolFlags: Ci.nsIProtocolHandler.URI_NORELATIVE |
                   Ci.nsIProtocolHandler.URI_NOAUTH |
                   Ci.nsIProtocolHandler.URI_LOADABLE_BY_ANYONE |
                   Ci.nsIProtocolHandler.URI_DOES_NOT_RETURN_DATA,

    // nsIProtocolHandler
    allowPort: function(aPort, aScheme) { return false },

    // nsIProtocolHandler
    newChannel: function(aURI) {
        let url = aURI.spec.slice(SUBSCRIBE_PREFIX.length);
        FeedUpdateService.addFeed(unescape(url));

        throw Components.results.NS_ERROR_ILLEGAL_VALUE;
    },

    // nsIProtocolHandler
    newURI: function(aSpec, aOriginCharset, aBaseURI) {
        let uri = Cc['@mozilla.org/network/standard-url;1'].createInstance(Ci.nsIStandardURL);
        uri.init(Ci.nsIStandardURL.URLTYPE_STANDARD, this.defaultPort,
                 aSpec, aOriginCharset, null);
        return uri.QueryInterface(Ci.nsIURI);
    },


    classDescription: 'Brief protocol handler',
    classID: Components.ID('{dd940a26-3ab1-11e3-b1c2-ce3f5508acd9}'),
    contractID: '@mozilla.org/network/protocol;1?name=brief',
    QueryInterface : XPCOMUtils.generateQI([Ci.nsIProtocolHandler])

}

let NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefProtocolHandler]);
