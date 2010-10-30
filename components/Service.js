const Cc = Components.classes;
const Ci = Components.interfaces;

Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

function BriefService() {
    // Firefox 4 component registration.
    if (XPCOMUtils.generateNSGetFactory) {
        Components.utils.import('resource://brief/Storage.jsm');
    }
    // Old component registration.
    else {
        let observerService = Cc['@mozilla.org/observer-service;1']
                              .getService(Ci.nsIObserverService);
        observerService.addObserver(this, 'profile-after-change', false);
    }
}

BriefService.prototype = {

    // nsIObserver
    observe: function BriefService_observe(aSubject, aTopic, aData) {
        if (aData == 'startup') {
            let observerService = Cc['@mozilla.org/observer-service;1']
                                  .getService(Ci.nsIObserverService);
            observerService.removeObserver(this, 'profile-after-change');

            Components.utils.import('resource://brief/Storage.jsm');
        }
    },

    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    _xpcom_categories: [ { category: 'app-startup', service: true } ],
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver])
}


/**
 * XPCOMUtils.generateNSGetFactory was introduced in Mozilla 2 (Firefox 4).
 * XPCOMUtils.generateNSGetModule is for Mozilla 1.9.2 (Firefox 3.6).
 */
if (XPCOMUtils.generateNSGetFactory)
    var NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefService]);
else
    var NSGetModule = XPCOMUtils.generateNSGetModule([BriefService]);
