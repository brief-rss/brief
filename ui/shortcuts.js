import {apply_i18n} from "/modules/i18n.js";


async function onload() {
    apply_i18n(document);
    let elems = window.navigator.platform.match('Mac')
        ? document.getElementsByClassName('noMac')
        : document.getElementsByClassName('onlyMac');

    for (let i = 0; i < elems.length; i++) {
        (/** @type HTMLElement */ (elems[i])).style.display = 'none';
    }

    // Workaround for mozilla bug 1408446
    let {id, height} = await browser.windows.getCurrent();
    await browser.windows.update(id, {height: height + 1});
}

function onKeyup({key}) {
    if (key == "Escape") {
        window.close();
    }
}

window.addEventListener('load', onload, false);
document.addEventListener('keyup', onKeyup, false);
