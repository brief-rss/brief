import {apply_i18n} from "/modules/i18n.js";


async function onload() {
    apply_i18n(document);
    document.body.classList.toggle('platform-mac', window.navigator.platform.match('Mac') !== null);

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
