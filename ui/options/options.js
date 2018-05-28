import {Database} from "/scripts/database.js";
import {apply_i18n} from "/scripts/i18n.js";
import {Prefs} from "/scripts/prefs.js";
import {Comm} from "/scripts/utils.js";
import {PrefBinder, Enabler} from "./options-common.js";


async function init() {
    apply_i18n(document);
    Comm.registerObservers({
        'is-options-window-open': async () => true,
    });

    await Prefs.init();
    PrefBinder.init();
    Enabler.init();

    initUpdateIntervalControls();

    await Database.init();

    StyleEditor.init();
}

function initUpdateIntervalControls() {
    let scaleMenu = document.getElementById('update-time-menulist');
    let interval = document.getElementById('updateInterval');

    scaleMenu.addEventListener('change', () => {
        let scale = 1;
        switch (scaleMenu.selectedIndex) {
            case 2: scale *= 24; // days to hours and fallthrough
            case 1: scale *= 60; // hours to minutes and fallthrough
            case 0: scale *= 60; // minutes to seconds
        }
        PrefBinder.updateScale(interval, scale);
    });

    let value = Prefs.get(interval.dataset.pref);
    let asDays = value / (60*60*24);
    let asHours = value / (60*60);

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
    let event = new Event("change", {bubbles: true, cancelable: false});
    scaleMenu.dispatchEvent(event);

    document.getElementById('clear-all-entries').addEventListener('click', async () => {
        if (window.confirm(browser.i18n.getMessage('confirmClearAllEntriesText'))) {
            await Database.query({
                starred: Prefs.get('database.keepStarredWhenClearing') ? 0 : undefined,
                includeHiddenFeeds: true
            }).markDeleted('deleted').catch(console.error);
        }
    });
    window.addEventListener('beforeunload',
                            () => Database.expireEntries(),
                            {once: true, passive: true});
}


let StyleEditor = {
    EXAMPLE_CSS: '/* Example: change font size of item title */\n.title-link {\n    font-size: 15px;\n}',

    editor: null,

    async init() {
        let {custom_css: style} = await browser.storage.local.get({'custom_css': this.EXAMPLE_CSS});
        this.editor = document.getElementById('custom-style-textbox');
        this.editor.value = style;

        this.editor.addEventListener('change', () => this.save());
    },

    async save() {
        let style = this.editor.value;
        await browser.storage.local.set({'custom_css': style});

        Comm.broadcast('style-updated');
    },
};


window.addEventListener('load', () => init(), {once: true, passive: true});
