Components.utils.import('resource://digest/common.jsm');
Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');
Components.utils.import("resource://gre/modules/AddonManager.jsm");

IMPORT_COMMON(this);

function DigestService() {
    // Initialize Storage module.
    Components.utils.import('resource://digest/Storage.jsm');

    // Registers %profile%/chrome directory under a resource URI.
    let resourceProtocolHandler = Services.io.getProtocolHandler('resource')
                                             .QueryInterface(Ci.nsIResProtocolHandler);
    if (!resourceProtocolHandler.hasSubstitution('profile-chrome-dir')) {
        let chromeDir = Services.dirsvc.get('ProfD', Ci.nsIFile);
        chromeDir.append('chrome');
        let chromeDirURI = Services.io.newFileURI(chromeDir);
        resourceProtocolHandler.setSubstitution('profile-chrome-dir', chromeDirURI);
    }
}

DigestService.prototype = {

    // mozIStorageVacuumParticipant
    get databaseConnection() {
        return Components.utils.getGlobalForObject(Storage).Connection._nativeConnection;
    },

    // mozIStorageVacuumParticipant
    expectedDatabasePageSize: Ci.mozIStorageConnection.DEFAULT_PAGE_SIZE,

    // mozIStorageVacuumParticipant
    onBeginVacuum: function onBeginVacuum() {
        Components.utils.import('resource://digest/FeedUpdateService.jsm');
        FeedUpdateService.stopUpdating();

        return true;
    },

    // mozIStorageVacuumParticipant
    onEndVacuum: function onEndVacuum(aSucceeded) {

    },

    // nsIObserver
    observe: function(key, topic) {
        if(topic == 'profile-after-change') {
            log("profile-after-change");
            AddonManager.getAddonByID('brief@mozdev.org', function(addon) {
                if(addon.isActive) {
                    let prompts = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
                            .getService(Components.interfaces.nsIPromptService);
                    let result = prompts.confirm(null, "Upgrade to Digest",
                            "The extension Brief is enabled.\n" +
                            "Digest needs to disable it and restart the browser.");
                    if(result) {
                        addon.userDisabled = true;
                        restart();
                    }
                }
            })
        }
    },

    classDescription: 'Service of Digest extension',
    classID: Components.ID('{7be39418-cdae-4f37-8c97-ae5323954682}'),
    contractID: '@tanriol.github.io/digest/service;1',
    QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver,
                                           Ci.mozIStorageVacuumParticipant])

}

let NSGetFactory = XPCOMUtils.generateNSGetFactory([DigestService]);
