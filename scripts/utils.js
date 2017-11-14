'use strict';

// ===== Promise utilities =====

// Adapt setTimeout for Promises
function wait(delay) {
    return new Promise(resolve => setTimeout(() => resolve(), delay));
}

// Wait for a specific event (for example, 'transitionend')
function expectedEvent(element, event) {
    return new Promise((resolve, reject) => {
        element.addEventListener(event, resolve, {once: true, passive: true});
    });
}

function xhrPromise(request) {
    return new Promise((resolve, reject) => {
        request.onload = () => resolve(request.response);
        request.onerror = e => reject(e);
        request.onabort = e => reject(e);
        request.send();
    });
}

// ===== Misc helpers =====

// Iterate nodes in a XPathResult
function iterSnapshot(result) {
    return {
        [Symbol.iterator]: function*() {
            for(let i = 0; i < result.snapshotLength; i++){
                yield result.snapshotItem(i);
            }
        }
    }
}

function RelativeDate(aAbsoluteTime) {
    this.currentDate = new Date();
    this.currentTime = this.currentDate.getTime() - this.currentDate.getTimezoneOffset() * 60000;

    this.targetDate = new Date(aAbsoluteTime);
    this.targetTime = this.targetDate.getTime() - this.targetDate.getTimezoneOffset() * 60000;
}

RelativeDate.prototype = {

    get deltaMinutes() { return this._getDelta(60000) },
    get deltaMinuteSteps() { return this._getSteps(60000) },

    get deltaHours() { return this._getDelta(3600000) },
    get deltaHourSteps() { return this._getSteps(3600000) },

    get deltaDays() { return this._getDelta(86400000) },
    get deltaDaySteps() { return this._getSteps(86400000) }, //Unexact due to timezones

    get deltaYears() { return this._getDelta(31536000000) },
    get deltaYearSteps() {
        return (this.currentDate.getFullYear() -
                this.targetDate.getFullYear());
     },

    _getSteps: function RelativeDate__getSteps(aDivisor) {
        let current = Math.ceil(this.currentTime / aDivisor);
        let target = Math.ceil(this.targetTime / aDivisor);
        return current - target;
    },

    _getDelta: function RelativeDate__getDelta(aDivisor) {
        return Math.floor((this.currentTime - this.targetTime) / aDivisor);
    }

}


function getPluralForm(number, forms) {
    /*
    let pluralRule = Services.strings.createBundle('chrome://brief/locale/brief.properties')
                                 .GetStringFromName('pluralRule');
    let getPluralForm = PluralForm.makeGetter(pluralRule)[0];
    */
    let knownForms = browser.i18n.getMessage('pluralRule').split(';');
    let form;
    if(Intl.PluralRules !== undefined) {
        let rules = new Intl.PluralRules();
        form = rules.select(number);
    } else {
        let lang = browser.i18n.getUILanguage().replace(/-.*/, '');
        form = pluralRulesDb.cardinal[lang](number);
    }
    return forms.split(';')[knownForms.indexOf(form)];
}


async function openBackgroundTab(url) {
    let tab = await browser.tabs.getCurrent();
    try {
        await browser.tabs.create({active: false, url: url, openerTabId: tab.id})
    }
    catch(e) {
        if(e.message.includes("openerTabId")) {
            await browser.tabs.create({active: false, url: url})
        } else {
            throw e;
        }
    }
}
