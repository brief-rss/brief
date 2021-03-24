import {Prefs} from "/modules/prefs.js";


export let PrefBinder = {
    init(options) {
        if(options) {
            this.getter = options.getter;
            this.setter = options.setter;
        } else {
            this.getter = name => Prefs.get(name);
            this.setter = (name, value) => Prefs.set(name, value);
        }

        for(let node of document.querySelectorAll('[data-pref]')) {
            node.addEventListener('change', () => this.saveValue(node));
        }
        this.refresh();
    },

    refresh() {
        for(let node of document.querySelectorAll('[data-pref]')) {
            let name = (/** @type {HTMLElement} */(node)).dataset.pref;
            let value = this.getter(name);
            this._setValue(node, value);
        }
    },

    updateScale(node, scale) {
        node.dataset.prefScale = scale;
        let value = this.getter(node.dataset.pref);
        this._setValue(node, value);
    },

    _mapTo(value, {prefScale, prefInvert}) {
        if(prefScale !== undefined) {
            return value / prefScale;
        }
        if(prefInvert !== undefined) {
            return !value;
        }
        return value;
    },

    _mapFrom(value, {prefScale, prefInvert}) {
        if(prefScale !== undefined) {
            return value * prefScale;
        }
        if(prefInvert !== undefined) {
            return !value;
        }
        return value;
    },

    _setValue(node, value) {
        value = this._mapTo(value, node.dataset);
        switch(node.type) {
            case "checkbox":
                node.checked = value;
                break;
            case "number":
            case "text":
                node.value = value;
                break;
        }
    },

    getValue(node) {
        let value;
        switch(node.type) {
            case "checkbox":
                value = node.checked;
                break;
            case "number":
                value = Number(node.value);
                break;
            case "text":
                value = node.value;
                break;
        }
        return this._mapFrom(value, node.dataset);
    },

    saveValue(node, value) {
        let name = node.dataset.pref;
        if(value === undefined) {
            value = this.getValue(node);
        }
        if(value !== this.getter(name)) {
            this.setter(name, value);
        }
    },
};

export let Enabler = {
    init() {
        for(let candidate of document.querySelectorAll('[data-requires]')) {
            let node = /** @type {HTMLInputElement | HTMLSelectElement} */ (candidate);
            let master = /** @type {HTMLInputElement} */(document.getElementById(node.dataset.requires));
            node.disabled = !master.checked;
            master.addEventListener('change', () => {
                node.disabled = !master.checked;
            });
        }
    },
};
