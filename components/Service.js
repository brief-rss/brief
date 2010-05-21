const Cc = Components.classes;
const Ci = Components.interfaces;

Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

var Service = null;

function BriefService() {
    var observerService = Cc['@mozilla.org/observer-service;1']
                          .getService(Ci.nsIObserverService);
    observerService.addObserver(this, 'profile-after-change', false);
}

BriefService.prototype = {

    // nsIObserver
    observe: function BriefService_observe(aSubject, aTopic, aData) {
        if (aData == 'startup') {
            var observerService = Cc['@mozilla.org/observer-service;1']
                                  .getService(Ci.nsIObserverService);
            observerService.removeObserver(this, 'profile-after-change');

            // Initialize modules.
            Components.utils.import('resource://brief/Storage.jsm');
        }
    },

    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    _xpcom_categories: [ { category: 'app-startup', service: true } ],
    _xpcom_factory: {
        createInstance: function(aOuter, aIID) {
            if (aOuter != null)
                throw Components.results.NS_ERROR_NO_AGGREGATION;

            if (!Service)
                Service = new BriefService();

            return Service.QueryInterface(aIID);
        }
    },
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver])
}

function NSGetModule(compMgr, fileSpec) XPCOMUtils.generateModule([BriefService])