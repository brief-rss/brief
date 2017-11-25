'use strict';

async function init() {
    apply_i18n(document);

    Enabler.init();

    let feedID = (new URLSearchParams(document.location.search)).get('feedID');
    await Prefs.init();
    await Database.init();
    let feed = Database.getFeed(feedID);

    PrefBinder.init({
        getter: name => {
            switch(name) {
                case 'update-enabled':
                    return (feed.updateInterval > 0);
                case 'expire-enabled':
                    return (feed.entryAgeLimit > 0);
                case 'updateInterval':
                    feed._updateInterval = (feed.updateInterval ||
                                            Prefs.get('update.interval') * 1000);
                    return feed._updateInterval;
                case 'entryAgeLimit':
                    feed._entryAgeLimit = (feed.entryAgeLimit ||
                                           Prefs.get('database.entryExpirationAge'));
                    return feed._entryAgeLimit;
                default: return feed[name];
            }
        },
        setter: (name, value) => {
            switch(name) {
                case 'update-enabled':
                    name = 'updateInterval';
                    if(value) {
                        value = feed._updateInterval;
                    } else {
                        value = 0;
                    }
                    break;
                case 'expire-enabled':
                    name = 'entryAgeLimit';
                    if(value) {
                        value = feed._entryAgeLimit;
                    } else {
                        value = 0;
                    }
                    break;
                // 'updateInterval' and 'entryAgeLimit' can't be modified while not active
            }
            feed[name] = value;
            Database.modifyFeed({
                feedID: feed.feedID,
                [name]: value
            });
        },
    });

    let scaleMenu = document.getElementById('update-time-menulist');
    let interval = document.getElementById('updateInterval');

    scaleMenu.addEventListener('change', () => updateScale());

    Comm.registerObservers({
        'feedlist-updated': async ({feeds}) => {
            await wait();
            let newFeed = Database.getFeed(feedID);
            if(newFeed === undefined) {
                window.close();
                return;
            }
            //TODO: maybe update the fields?
        },
        'is-options-window-open': async () => true,
    });

    setFeed(feed);

    let allFeeds = Database.feeds.filter(f => !f.hidden && !f.isFolder);
    let index = allFeeds.map(f => f.feedID).indexOf(feedID);
    document.getElementById('next-feed').disabled = (index == allFeeds.length - 1);
    document.getElementById('previous-feed').disabled = (index == 0);
    document.getElementById('next-feed').addEventListener('click', () => {
        document.location.search = `?feedID=${allFeeds[index+1].feedID}`;
    });
    document.getElementById('previous-feed').addEventListener('click', () => {
        document.location.search = `?feedID=${allFeeds[index-1].feedID}`;
    });
    window.addEventListener('beforeunload',
                            () => Database.expireEntries(),
                            {once: true, passive: true});

    // Workaround for mozilla bug 1408446
    let {id, height} = await browser.windows.getCurrent();
    await browser.windows.update(id, {height: height + 1});
}

function updateScale() {
    let scaleMenu = document.getElementById('update-time-menulist');
    let interval = document.getElementById('updateInterval');
    let scale = 1;
    switch (scaleMenu.selectedIndex) {
        // Fallthrough everywhere: from days
        case 2: scale *= 24; // to hours
        case 1: scale *= 60; // to minutes
        case 0: scale *= 60; // to seconds
                scale *= 1000; // to milliseconds
    }
    PrefBinder.updateScale(interval, scale);
}

function setFeed(feed) {
    document.title = browser.i18n.getMessage('feedSettingsDialogTitle', feed.title);

    PrefBinder.refresh();

    // Guess interval scale
    let interval = document.getElementById('updateInterval');
    let scaleMenu = document.getElementById('update-time-menulist');
    let value = PrefBinder.getValue(interval);
    let asDays = value / (1000*60*60*24);
    let asHours = value / (1000*60*60);
    let toMinutes = value / (1000*60);

    // Select the largest scale that has an exact value
    switch (true) {
        case Math.ceil(asDays) == asDays:
            scaleMenu.selectedIndex = 2;
            break;
        case Math.ceil(asHours) == asHours:
            scaleMenu.selectedIndex = 1;
            break;
        default:
            scaleMenu.selectedIndex = 0;
            break;
    }
    updateScale();
}


window.addEventListener('load', () => init(), {once: true, passive: true});
