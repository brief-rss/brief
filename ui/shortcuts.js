'use strict';

function onload(aEvent) {
    apply_i18n(document);
    var elems = window.navigator.platform.match('Mac')
                ? document.getElementsByClassName('noMac')
                : document.getElementsByClassName('onlyMac');

    for (let i = 0; i < elems.length; i++)
        elems[i].style.display = 'none';
}

function onKeypress(aEvent) {
    if (aEvent.keyCode == aEvent.DOM_VK_ESCAPE)
        window.close();
}

window.addEventListener('load', onload, false);
document.addEventListener('keypress', onKeypress, false);
