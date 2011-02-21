const Cc = Components.classes;
const Ci = Components.interfaces;

Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

function BriefService() {
    Components.utils.import('resource://brief/Storage.jsm');

    // Registers %profile%/chrome directory under a resource URI.
    let ioService = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
    let resourceProtocolHandler = ioService.getProtocolHandler('resource')
                                           .QueryInterface(Ci.nsIResProtocolHandler);
    if (!resourceProtocolHandler.hasSubstitution('profile-chrome-dir')) {
        let chromeDir = Cc['@mozilla.org/file/directory_service;1'].
                        getService(Ci.nsIProperties).
                        get('ProfD', Ci.nsIFile);
        chromeDir.append('chrome');
        let chromeDirURI = ioService.newFileURI(chromeDir);
        resourceProtocolHandler.setSubstitution('profile-chrome-dir', chromeDirURI);
    }
}

BriefService.prototype = {

    classDescription: 'Service of Brief extension',
    classID: Components.ID('{943b2280-6457-11df-a08a-0800200c9a66}'),
    contractID: '@brief.mozdev.org/briefservice;1',
    QueryInterface: XPCOMUtils.generateQI()

}

let NSGetFactory = XPCOMUtils.generateNSGetFactory([BriefService]);
