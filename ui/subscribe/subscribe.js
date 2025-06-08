import {Comm, previewUrl} from "/modules/utils.js";

async function onload() {
    let {id: windowId, incognito} = await browser.windows.getCurrent();
    let [{id: tabId}] = await browser.tabs.query({active: true, windowId});

    let feeds = await Comm.callMaster('subscribe-get-feeds', {windowId});
    if(feeds.length === 0) {
        console.log('Nothing to subscribe to');
        return;
    }
    if(feeds.length === 1 && !incognito) {
        Comm.callMaster('subscribe-add-feed', {feed: feeds[0]});
        window.close();
        return;
    }

    for(let feed of feeds) {
        let node = document.createElement('span');
        node.className ="feed";
        node.textContent = feed.linkTitle;
        node.title = feed.url;
        node.addEventListener('click', () => {
            if(incognito) {
                browser.tabs.update(tabId, {url: previewUrl(feed.url)});
            } else {
                Comm.callMaster('subscribe-add-feed', {feed});
            }
            window.close();
        });
        document.body.appendChild(node);
    }
}

window.addEventListener('load', onload, false);
