async function init() {
    window.addEventListener('unload', () => unload(), {once: true, passive: true});

    apply_i18n(document);

    await Prefs.init();
    PrefBinder.init();
    Enabler.init();

    initUpdateIntervalControls();
    //TODO: custom style
}

function initUpdateIntervalControls() {
    let scaleMenu = document.getElementById('update-time-menulist');
    let interval = document.getElementById('updateInterval');

    scaleMenu.addEventListener('change', () => {
        let scale = 1;
        switch (scaleMenu.selectedIndex) {
            // Fallthrough everywhere: from days
            case 2: scale *= 24; // to hours
            case 1: scale *= 60; // to minutes
            case 0: scale *= 60; // to seconds
        }
        PrefBinder.updateScale(interval, scale);
    });

    let value = Prefs.get(interval.dataset.pref);
    let asDays = value / (60*60*24);
    let asHours = value / (60*60);
    let toMinutes = value / 60;

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
}


function onClearAllEntriesCmd(aEvent) {
    let keepStarred = Services.prefs.getBoolPref('extensions.brief.database.keepStarredWhenClearing');

    let stringbundle = document.getElementById('options-bundle');
    let title = stringbundle.getString('confirmClearAllEntriesTitle');
    let text = stringbundle.getString('confirmClearAllEntriesText');
    let checkboxLabel = stringbundle.getString('confirmClearAllEntriesCheckbox');
    let checked = { value: keepStarred };

    if (Services.prompt.confirmCheck(window, title, text, checkboxLabel, checked)) {
        let query = new Query({
            starred: checked.value ? false : undefined,
            includeHiddenFeeds: true
        });

        Storage.ready.then(() =>
            query.deleteEntries('deleted')
        )

        Services.prefs.setBoolPref('extensions.brief.database.keepStarredWhenClearing', checked.value)
    }
}

let PrefBinder = {
    init() {
        for(let node of document.querySelectorAll('[data-pref]')) {
            let name = node.dataset.pref;
            let scale = () => (node.dataset.prefScale || 1);
            let value = Prefs.get(name);
            this._setValue(node, value / scale());
            node.addEventListener('change', e => {
                let value = this._getValue(node);
                if(value !== Prefs.get(name)) {
                    Prefs.set(name, value * scale());
                }
            });
        }

    },

    updateScale(node, scale) {
        node.dataset.prefScale = scale;
        let value = Prefs.get(node.dataset.pref);
        this._setValue(node, value / scale);
    },

    _setValue(node, value) {
        switch(node.type) {
            case "checkbox":
                node.checked = value;
            case "number":
                node.value = value;
        }
    },

    _getValue(node) {
        switch(node.type) {
            case "checkbox":
                return node.checked;
            case "number":
                return Number(node.value);
        }
    },
};

let Enabler = {
    init() {
        for(let node of document.querySelectorAll('[data-requires]')) {
            let master = document.getElementById(node.dataset.requires);
            node.disabled = !master.checked;
            master.addEventListener('change', e => {
                node.disabled = !master.checked;
            });
        }
    },
};


window.addEventListener('load', () => init(), {once: true, passive: true});
