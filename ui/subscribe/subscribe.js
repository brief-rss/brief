import {Comm} from "/scripts/utils.js";


async function onload(aEvent) {
    let {id: windowId} = await browser.windows.getCurrent();

    let feeds = await Comm.callMaster('subscribe-get-feeds', {windowId});
    if(feeds.length === 0) {
        console.log('Nothing to subscribe to');
        return;
    } else if(feeds.length === 1) {
        Comm.callMaster('subscribe-add-feed', {feed: feeds[0]});
        window.close();
        return;
    } else {
        for(let feed of feeds) {
            let node = document.createElement('span');
            node.className ="feed";
            node.textContent = feed.linkTitle;
            node.title = feed.url;
            node.addEventListener('click', () => {
                Comm.callMaster('subscribe-add-feed', {feed});
                window.close();
            });
            document.body.appendChild(node);
        }
    }
}

window.addEventListener('load', onload, false);
