'use strict';

async function onload(aEvent) {
    apply_i18n(document);
    var elems = window.navigator.platform.match('Mac')
                ? document.getElementsByClassName('noMac')
                : document.getElementsByClassName('onlyMac');

    for (let i = 0; i < elems.length; i++)
        elems[i].style.display = 'none';

    // Workaround for mozilla bug 1408446
    let {id, height} = await browser.windows.getCurrent();
    await browser.windows.update(id, {height: height + 1});
}

function onKeypress(aEvent) {
    if (aEvent.keyCode == aEvent.DOM_VK_ESCAPE)
        window.close();
}

window.addEventListener('load', onload, false);
document.addEventListener('keypress', onKeypress, false);
