const BRIEF_URL = 'chrome://brief/content/brief.xul';

var gBrief = {
  
  // Stores the tab in which Brief is loaded so we can ensure only instance can
  // be open at a time. This is a UI choice, not a technical limitation.
  tab: null,
  briefStatus: null,
  
  init: function() {
    this.prefs = Cc["@mozilla.org/preferences-service;1"].
                 getService(Ci.nsIPrefService).
                 getBranch("extensions.brief.");
    this.prefs.QueryInterface(Ci.nsIPrefBranch2).addObserver('', this, false);
    
    var firstRun = this.prefs.getBoolPref('firstRun');
    if (firstRun)
      this.onFirstRun();    
    
    this.briefStatus = document.getElementById('brief-status');
    var showStatus = this.prefs.getBoolPref('showStatusbarIcon');
    if (showStatus) {
      this.briefStatus.hidden = false;
      this.updateStatuspanel();
    }

    var observerService = Cc["@mozilla.org/observer-service;1"].
                          getService(Ci.nsIObserverService);
    observerService.addObserver(this, 'brief:feed-updated', false);
    observerService.addObserver(this, 'brief:sync-to-livemarks', false);
    observerService.addObserver(this, 'brief:entry-status-changed', false);
    
    window.removeEventListener('load', this, false);
    window.addEventListener('TabClose', this, false);
    window.addEventListener('unload', this, false);
  },
  
  
  openBrief: function(aEvent) {
    if (!aEvent || aEvent.button == 1) {
      // If Brief is already open then select the existing tab
      if (gBrief.tab)
        gBrowser.selectedTab = gBrief.tab;
      else {
        gBrief.tab = gBrowser.loadOneTab(BRIEF_URL, null, null, null, false);
        var browser = gBrowser.getBrowserForTab(gBrief.tab);
        browser.addEventListener('load', gBrief.onBriefTabLoad, true);
      }
    }
    
    else if (aEvent.button == 0) {
      // If Brief is already open then select the existing tab
      if (gBrief.tab)
        gBrowser.selectedTab = gBrief.tab;
      else {      
        gBrowser.loadURI(BRIEF_URL, null, null);
        gBrief.tab = gBrowser.selectedTab;
        var browser = gBrowser.getBrowserForTab(gBrief.tab);
        browser.addEventListener('load', gBrief.onBriefTabLoad, true);
      }
    }
    
	},
	
	
	onBriefTabLoad: function(aEvent) {
    if (this.currentURI.spec != BRIEF_URL) {
      gBrief.tab = null;
      this.removeEventListener('load', gBrief.onBriefTabLoad, true);
    }
  },
  
  
  updateFeeds: function() {
    var updateService = Cc['@mozilla.org/brief/updateservice;1'].
                        createInstance(Ci.nsIBriefUpdateService);
    updateService.fetchAllFeeds();
  },
  
  
  updateStatuspanel: function() {
    var counter = document.getElementById('brief-status-counter');
    var panel = document.getElementById('brief-status');
    
    var storageService = Cc['@mozilla.org/brief/storage;1'].
                         createInstance(Ci.nsIBriefStorage);
    var unreadEntriesCount = storageService.getEntriesCount(null, 'unread', null);

    counter.value = unreadEntriesCount;
    panel.setAttribute('unread', unreadEntriesCount > 0); 
  },
  
	
	handleEvent: function(aEvent) {

    switch (aEvent.type) {
      case 'load':
        this.init();
        break;
      
      case 'unload':
        this.prefs.removeObserver('', this);
        var observerService = Cc["@mozilla.org/observer-service;1"].
                              getService(Ci.nsIObserverService);
        observerService.removeObserver(this, 'brief:feed-updated');
        observerService.removeObserver(this, 'brief:entry-status-changed');
        observerService.removeObserver(this, 'brief:sync-to-livemarks');
        break;
        
      case 'TabClose':
        if (aEvent.originalTarget == this.tab)
          this.tab = null;
        break;
    }
  },
  
  
  onFirstRun: function() {
    // Add the toolbar button to the Navigation Bar.
    var navbar = document.getElementById("nav-bar");
    var newset = navbar.currentSet.replace('urlbar-container,',
                                           'brief-button,urlbar-container,');
    navbar.currentSet = newset;
    navbar.setAttribute("currentset", newset);
    document.persist("nav-bar", "currentset");
    
    this.prefs.setBoolPref('firstRun', false);
  },  
  
  
  observe: function(aSubject, aTopic, aData) {
    switch (aTopic) {
      case 'brief:sync-to-livemarks':
        if (!this.briefStatus.hidden)
          this.updateStatuspanel();
        break;
      
      case 'brief:feed-updated':
        if (aSubject.QueryInterface(Ci.nsIVariant) > 0 &&
            !this.briefStatus.hidden)
          this.updateStatuspanel();
        break;
      
      case 'brief:entry-status-changed':
        if ((aData == 'read' || (aData == 'unread') || aData == 'deleted') && 
            !this.briefStatus.hidden)
          this.updateStatuspanel();
        break;
        
      case 'nsPref:changed':
        switch (aData) {
          case 'showStatusbarIcon':
            var newValue = this.prefs.getBoolPref('showStatusbarIcon');
            var briefStatus = document.getElementById('brief-status');
            briefStatus.hidden = !newValue;
            if (newValue)
              this.updateStatuspanel();
            break;
        }
        break;
    }
  }
  
};

window.addEventListener('load', gBrief, false);


function dump(aMessage) {
	var consoleService = Cc['@mozilla.org/consoleservice;1']
	                     .getService(Ci.nsIConsoleService);
	consoleService.logStringMessage('Brief:\n ' + aMessage);
}
