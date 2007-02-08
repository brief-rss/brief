const CLASS_ID    = Components.ID('{13A031E4-7EE9-11DB-8E2E-A58155D89593}');
const CLASS_NAME  = 'Service responsible for updating feed data';
const CONTRACT_ID = '@mozilla.org/brief/updateservice;1';

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;

const TIMER_TYPE_PRECISE     = Ci.nsITimer.TYPE_REPEATING_PRECISE;
const TIMER_TYPE_SLACK       = Ci.nsITimer.TYPE_REPEATING_SLACK;
const DEFAULT_FETCH_DELAY    = 250;
const BACKGROUND_FETCH_DELAY = 2000;
const ICON_DATAURL_PREFIX    = 'data:image/x-icon;base64,';
const FEED_ICON_URL          = 'chrome://brief/skin/icon.png';

var gUpdateService = null;


// Class definition
function UpdateService() {
  this.updateTimer = Cc['@mozilla.org/timer;1'].
                     createInstance(Ci.nsITimer);
  this.fetchDelayTimer = Cc['@mozilla.org/timer;1'].
                         createInstance(Ci.nsITimer);
  this.observerService = Cc['@mozilla.org/observer-service;1'].
                         getService(Ci.nsIObserverService);
  this.prefs = Cc['@mozilla.org/preferences-service;1'].
               getService(Ci.nsIPrefService).
               getBranch('extensions.brief.').
               QueryInterface(Ci.nsIPrefBranch2);
  this.prefs.addObserver('', this, false);
  
  // Unfortunately alerts don't work on all platforms
  if (Ci.nsIAlertsService) {
    this.alertsService = Cc['@mozilla.org/alerts-service;1'].
                         getService(Ci.nsIAlertsService);
  }
                 
  this.observerService.addObserver(this, 'brief:feed-updated', false);
  this.observerService.addObserver(this, 'brief:feed-error', false);
  this.observerService.addObserver(this, 'profile-after-change', false);
};

UpdateService.prototype = {
  
  updateTimer:     null,
  fetchDelayTimer: null,
  storage:         null,
  observerService: null,
  prefs:           null,
  
  // Members specific to a single fetchAllFeeds call
  feeds:              null,  // array containing all feeds to be updated
  currentFeedIndex:   0,     // index of next feed to be fetched
  updatedFeedsCount:  0,     // number of updated feeds that have new entries
  newEntriesCount:    0,     // total number of new entries in all updated feeds
  updatingInProgress: 0,     // 0 - no, 1 - normal update, 2 - background update
  
  
  // See nsIBriefUpdateService
  updateServiceRunning: false,
  
  
  // See nsIBriefUpdateService
  startUpdateService: function() {
    if (this.updateServiceRunning)
      throw('Update service is already running.')
    this.updateServiceRunning = true;
    
    var interval = this.prefs.getIntPref('update.interval');
    if (interval == 0)
      throw('Updating is preffed off.');

    // updateCheckInterval is in minutes so let's convert it to ms
    interval *= 60000;
    this.updateTimer.initWithCallback(this, interval, TIMER_TYPE_SLACK);
  },
  
  
  // See nsIBriefUpdateService
  stopUpdateService: function() {
    this.updateTimer.cancel();
    this.updateServiceRunning = false;
  },

  
  // nsITimerCallback
  notify: function() {
    this.fetchAllFeeds(true);
  },
  
  
  // nsIBriefUpdateService
  fetchAllFeeds: function(aUpdateInBackground) {
    var storage = Cc['@mozilla.org/brief/storage;1'].
                  createInstance(Ci.nsIBriefStorage);
    this.feeds = storage.getAllFeeds({});
    
    // Prevent initiating more than one update at a time. If background update
    // is in progress and foreground update is attempted, we stop the background
    // update and restart. In all other cases attempting to start a new update 
    // while another is already running has no effect - we return early here.
    if ((this.updatingInProgress == 2 && aUpdateInBackground) || 
         this.updatingInProgress == 1 || this.feeds.length == 0)
      return;
      
    if (!aUpdateInBackground) {
      this.observerService.notifyObservers(null, 'brief:batch-update-started', '');
      if (this.updatingInProgress == 2)
        this.fetchDelayTimer.cancel();
    }  
    
    // Set up all the members for a new update.
    this.updatingInProgress = aUpdateInBackground ? 2 : 1;
    this.currentFeedIndex = 0;
    this.finishedFeedsCount = 0;
    this.updatedFeedsCount = 0;
    this.newEntriesCount = 0;
    
    // We will fetch feeds on an interval, so we don't choke when downloading
    // and processing all of them a once.
    var callback = this.fetchDelayCallback;
    var delay = aUpdateInBackground ? BACKGROUND_FETCH_DELAY 
                                    : DEFAULT_FETCH_DELAY;
    this.fetchDelayTimer.initWithCallback(callback, delay, TIMER_TYPE_SLACK);
  },


	// Subclass implementing nsITimerCallback
	fetchDelayCallback: {
    
    notify: function(aTimer) {
      var self = gUpdateService;

      var currentFeed = self.feeds[self.currentFeedIndex];
      new FeedFetcher(currentFeed);
      self.currentFeedIndex++;
      
      // Check if all feeds have been already fetched
      if (self.currentFeedIndex == self.feeds.length)
        aTimer.cancel();
    }
  
  },
  
  
  // nsIBriefUpdateService
  fetchFeed: function(aFeedId) {
    if (this.updatingInProgress != 1) {
      var storage = Cc['@mozilla.org/brief/storage;1'].
                    createInstance(Ci.nsIBriefStorage);
      var feed = storage.getFeed(aFeedId);
      new FeedFetcher(feed);
    }
  },    
  
  
  // nsIObserver
  observe: function(aSubject, aTopic, aData) {
    switch (aTopic) {
      
      // Startup initialization. We use this instead of app-startup,
      // so that the preferences are already initialized
      case 'profile-after-change':
        if (aData == 'startup') {
          if (this.prefs.getBoolPref('update.performAtStartup'))
            this.fetchAllFeeds(BACKGROUND_FETCH_DELAY);
          if (this.prefs.getIntPref('update.interval'))
            this.startUpdateService();
        }
        break;
              
      // Count updated feeds, so we can show this number in the alert when
      // updating is completed.   
      case 'brief:feed-error':
      case 'brief:feed-updated':
        if (this.updatingInProgress == 0)
          // This isn't a batch update.
          return;
        
        this.finishedFeedsCount++;
        if (aSubject.QueryInterface(Ci.nsIVariant) > 0) {
          this.newEntriesCount += aSubject.QueryInterface(Ci.nsIVariant);
          this.updatedFeedsCount++;
        }

        if (this.finishedFeedsCount == this.feeds.length) {
          this.updatingInProgress = 0;

          var showNotification = this.prefs.getBoolPref('update.showNotification');
          if (this.updatedFeedsCount > 0 && showNotification && this.alertsService) {
            var strbundle = Cc['@mozilla.org/intl/stringbundle;1'].
                            getService(Ci.nsIStringBundleService).
                            createBundle('chrome://brief/locale/brief.properties');
            var title = strbundle.GetStringFromName('feedsUpdatedAlertTitle');
            var text = strbundle.formatStringFromName('feedsUpdateAlertText', 
                             [this.newEntriesCount, this.updatedFeedsCount], 2);

            this.alertsService.showAlertNotification(FEED_ICON_URL, title, text, 
                                                     true, null, this);
          }        
        }
        
        break;
        
      // Notification from nsIAlertsService that user has clicked the link in 
      // the alert
      case 'alertclickcallback':
        var window = Cc['@mozilla.org/appshell/window-mediator;1'].
                     getService(Ci.nsIWindowMediator).
	                   getMostRecentWindow("navigator:browser");
	       if (window) {
	         window.gBrief.openBrief();
	         window.focus();
	       }
	       break;
	       
      case 'nsPref:changed':       
        switch (aData) {
          case 'update.interval':
            var newValue = this.prefs.getIntPref('update.interval');
            this.stopUpdateService();
            if (newValue > 0)
              this.startUpdateService()
            break;
        }
        break;
    }
  },


  // nsISupports
  QueryInterface: function(aIID) {
    if (!aIID.equals(Components.interfaces.nsIBriefUpdateService) && 
        !aIID.equals(Components.interfaces.nsISupports) &&
        !aIID.equals(Components.interfaces.nsITimerCallback) &&
        !aIID.equals(Components.interfaces.nsIObserver))
      throw Components.results.NS_ERROR_NO_INTERFACE;
    return this;
  }
  
};



function FeedFetcher(aFeed) {
  this.feed = aFeed;
  this.feedURL = aFeed.feedURL;
  this.feedId = aFeed.feedId;
  this.favicon = aFeed.favicon;
  
  this.observerService = Cc['@mozilla.org/observer-service;1'].
                         getService(Ci.nsIObserverService);
  this.observerService.notifyObservers(null, 'brief:feed-loading', this.feedId);

  this.requestFeed();
}

FeedFetcher.prototype = {
  
  feed:    null,
  feedURL: '',
  feedId:  '',
  favicon: '',
  downloadedFeed: null,

  requestFeed: function() {
    var self = this;
    
    function onRequestError() {
      self.observerService.notifyObservers(null, 'brief:feed-error', self.feedId);
      throw('Brief: connection error\n\n' + e);
    }
    
    function onRequestLoad() {
      var uri = Cc['@mozilla.org/network/io-service;1'].
                getService(Ci.nsIIOService).
                newURI(self.feedURL, null, null);
      var parser = Cc['@mozilla.org/feed-processor;1'].
	 	 	             createInstance(Ci.nsIFeedProcessor);
  	 	parser.listener = self;
      try {
        parser.parseFromString(request.responseText, uri);
  		}
	 	  catch(e) {
        self.observerService.notifyObservers(null, 'brief:feed-error', self.feedId);
        throw('Brief: feed parser error\n\n' + e);
      }
    }
    
    var request = Cc['@mozilla.org/xmlextras/xmlhttprequest;1'].
                  createInstance(Ci.nsIXMLHttpRequest);
    request.open('GET', this.feedURL, true);
    request.onload = onRequestLoad;
    request.onerror = onRequestError;
    request.send(null);
  },

  
  // nsIFeedResultListener
  handleResult: function(result) {
    var feed = result.doc.QueryInterface(Ci.nsIFeed);
  
    var wrappedFeed = Cc['@mozilla.org/brief/feed;1'].
                      createInstance(Ci.nsIBriefFeed);
    wrappedFeed.wrapFeed(feed);
    wrappedFeed.feedURL = this.feedURL;
    wrappedFeed.feedId = this.feedId;
    this.downloadedFeed = wrappedFeed;
    
    /* Now that we have the feed we can download the favicon if necessary. We 
       couldn't download it earlier, because we may have had no websiteURL.
       We must use websiteURL instead of feedURL for resolving the favicon URL, 
       because many websites use services like Feedburner for generating their 
       feeds and we'd get the Feedburner's favicon instead of the website's 
       favicon. */
    if (!this.favicon)
      this.getFavicon();
    // If we already have the favicon, we're ready to commit the data
    else
      this.passDataToStorage();
  },
  
  
  getFavicon: function() {
    if (!this.downloadedFeed.websiteURL) {
      this.favicon = 'no-favicon';
      this.passDataToStorage();
      return;
    }
      
    var uri = Cc['@mozilla.org/network/io-service;1'].
              getService(Ci.nsIIOService).
              newURI(this.downloadedFeed.websiteURL, null, null);
    new faviconFetcher(uri, this);
  },
  
  
  passDataToStorage: function() {
    this.downloadedFeed.favicon = this.favicon;
    storage = Cc['@mozilla.org/brief/storage;1'].
              createInstance(Ci.nsIBriefStorage);
    storage.updateFeed(this.downloadedFeed);
  }

}


// based on FeedWriter.js
function faviconFetcher(aWebsiteURI, aFeedFetcher) {
  var ios = Cc['@mozilla.org/network/io-service;1'].
            getService(Ci.nsIIOService);
  var faviconURI = ios.newURI(aWebsiteURI.prePath + '/favicon.ico', null, null);
  
  var chan = ios.newChannelFromURI(faviconURI);
  chan.notificationCallbacks = this;
  chan.asyncOpen(this, null);
  
  this.feedFetcher = aFeedFetcher; 
  this.websiteURI = aWebsiteURI;
  this._channel = chan;
  this._bytes = [];
}

faviconFetcher.prototype = {
  _channel:   null,
  _countRead: 0,
  _stream:    null,

  QueryInterface: function FW_IDUG_loadQI(aIID) {
    if (aIID.equals(Ci.nsISupports)           ||
        aIID.equals(Ci.nsIRequestObserver)    ||
        aIID.equals(Ci.nsIStreamListener)     ||
        aIID.equals(Ci.nsIChannelEventSink)   ||
        aIID.equals(Ci.nsIInterfaceRequestor) ||
        aIID.equals(Ci.nsIBadCertListener)    ||
        // See bug 358878 comment 11
        aIID.equals(Ci.nsIPrompt)             ||
        // See FIXME comment below
        aIID.equals(Ci.nsIHttpEventSink)      ||
        aIID.equals(Ci.nsIProgressEventSink)  ||
        false)
      return this;

    throw Cr.NS_ERROR_NO_INTERFACE;
  },

  // nsIRequestObserver
  onStartRequest: function FW_IDUG_loadStartR(aRequest, aContext) {
    this._stream = Cc["@mozilla.org/binaryinputstream;1"].
                   createInstance(Ci.nsIBinaryInputStream);
  },

  onStopRequest: function FW_IDUG_loadStopR(aRequest, aContext, aStatusCode) {
    var requestFailed = !Components.isSuccessCode(aStatusCode);
    if (!requestFailed && (aRequest instanceof Ci.nsIHttpChannel))
      requestFailed = !aRequest.requestSucceeded;

    if (!requestFailed && this._countRead != 0) {
      var dataURI = ICON_DATAURL_PREFIX + this._b64(this._bytes);
      this.feedFetcher.favicon = dataURI;
      this.feedFetcher.passDataToStorage();
    }
    else {
      this.feedFetcher.favicon = 'no-favicon';
      this.feedFetcher.passDataToStorage();
    }
    
    this._channel = null;
    this._element  = null;
  },

  // nsIStreamListener
  onDataAvailable: function(aRequest, aContext, aInputStream, aOffset, aCount) {
    this._stream.setInputStream(aInputStream);

    // Get a byte array of the data
    this._bytes = this._bytes.concat(this._stream.readByteArray(aCount));
    this._countRead += aCount;
  },

  // nsIChannelEventSink
  onChannelRedirect: function(aOldChannel, aNewChannel, aFlags) {
    this._channel = aNewChannel;
  },

  // nsIInterfaceRequestor
  getInterface: function(aIID) {
    return this.QueryInterface(aIID);
  },

  // nsIBadCertListener
  confirmUnknownIssuer: function(aSocketInfo, aCert, aCertAddType) {
    return false;
  },

  confirmMismatchDomain: function(aSocketInfo, aTargetURL, aCert) {
    return false;
  },

  confirmCertExpired: function(aSocketInfo, aCert) {
    return false;
  },

  notifyCrlNextupdate: function(aSocketInfo, aTargetURL, aCert) {
  },

  // FIXME: bug 253127
  // nsIHttpEventSink
  onRedirect: function(aChannel, aNewChannel) { },
  // nsIProgressEventSink
  onProgress: function(aRequest, aContext, aProgress, aProgressMax) { },
  onStatus: function(aRequest, aContext, aStatus, aStatusArg) { },
  
  // copied over from nsSearchService.js
  _b64: function(aBytes) {
    const B64_CHARS =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    var index = 0;
    function get3Bytes() {
      if (aBytes.length - index < 3)
        return null; // Less than three bytes remaining

      // Return the next three bytes in the array, and increment index for our
      // next invocation
      return aBytes.slice(index, index += 3);
    }

    var out = "";
    var bytes = null;
    while ((bytes = get3Bytes())) {
      var bits = 0;
      for (var i = 0; i < 3; i++) {
        bits <<= 8;
        bits |= bytes[i];
      }
      for (var j = 18; j >= 0; j -= 6)
        out += B64_CHARS[(bits>>j) & 0x3F];
    }

    // Get the remaining bytes
    bytes = aBytes.slice(index);

    switch (bytes.length) {
      case 2:
        out += B64_CHARS[(bytes[0]>>2) & 0x3F] +
               B64_CHARS[((bytes[0] & 0x03) << 4) | ((bytes[1] >> 4) & 0x0F)] +
               B64_CHARS[((bytes[1] & 0x0F) << 2)] +
               "=";
        break;
      case 1:
        out += B64_CHARS[(bytes[0]>>2) & 0x3F] +
               B64_CHARS[(bytes[0] & 0x03) << 4] +
               "==";
        break;
    }

    return out;
  }
  
};


var Factory = {
  createInstance: function (aOuter, aIID) {
    if (aOuter != null)
      throw Components.results.NS_ERROR_NO_AGGREGATION;
    if (!gUpdateService)
      gUpdateService = new UpdateService();
    return gUpdateService.QueryInterface(aIID);
  }
};

// Module definition (xpcom registration)
var Module = {
  _firstTime: true,
  
  registerSelf: function(aCompMgr, aFileSpec, aLocation, aType) {
    aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
    aCompMgr.registerFactoryLocation(CLASS_ID, CLASS_NAME, CONTRACT_ID, 
                                     aFileSpec, aLocation, aType);
    
    var categoryManager = Components.classes['@mozilla.org/categorymanager;1'].
                          getService(Components.interfaces.nsICategoryManager);
    categoryManager.addCategoryEntry('app-startup', 
                                     'nsIBriefUpdateService',
                                     CONTRACT_ID, true, true);
  },

  unregisterSelf: function(aCompMgr, aLocation, aType) {
    aCompMgr = aCompMgr.QueryInterface(Components.interfaces.nsIComponentRegistrar);
    aCompMgr.unregisterFactoryLocation(CLASS_ID, aLocation);
    
    var categoryManager = Components.classes['@mozilla.org/categorymanager;1'].
                          getService(Components.interfaces.nsICategoryManager);
    categoryManager.deleteCategoryEntry('app-startup', 
                                        'nsIBriefUpdateService',
                                        true);
  },
  
  getClassObject: function(aCompMgr, aCID, aIID) {
    if (!aIID.equals(Components.interfaces.nsIFactory))
      throw Components.results.NS_ERROR_NOT_IMPLEMENTED;

    if (aCID.equals(CLASS_ID))
      return Factory;

    throw Components.results.NS_ERROR_NO_INTERFACE;
  },

  canUnload: function(aCompMgr) { return true; },
 
};

// Module initialization
function NSGetModule(aCompMgr, aFileSpec) { return Module; }
