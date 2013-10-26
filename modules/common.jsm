const EXPORTED_SYMBOLS = ['IMPORT_COMMON', 'Cc', 'Ci', 'Cu', 'log',
                          'getPluralForm', 'RelativeDate'];

Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/Task.jsm');

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

function IMPORT_COMMON(aScope) {
    Object.defineProperty(aScope.Array.prototype, 'intersect', {
        value: Array.prototype.intersect,
        enumerable: false
    })

    Object.defineProperty(aScope.Function.prototype, 'gen', {
        value: Function.prototype.gen,
        enumerable: false
    })
}


Array.prototype.intersect = function intersect(aArr) {
    let commonItems = [];
    for (let i = 0; i < this.length; i++) {
        if (aArr.indexOf(this[i]) != -1)
            commonItems.push(this[i]);
    }
    return commonItems;
}



function log(aThing) {
    let str = aThing && typeof aThing == 'object' ? aThing.toSource() : aThing;
    Services.console.logStringMessage(str);
}


Function.prototype.gen = function() {
    let generatorFunction = this;

    return function generatorWrapper() {
        return Task.spawn(generatorFunction.apply(this, arguments));
    }
}


function RelativeDate(aAbsoluteTime) {
    let currentDate = new Date();
    this.currentTime = currentDate.getTime() - currentDate.getTimezoneOffset() * 60000;

    let targetDate = new Date(aAbsoluteTime);
    this.targetTime = targetDate.getTime() - targetDate.getTimezoneOffset() * 60000;
}

RelativeDate.prototype = {

    get deltaMinutes() this._getDelta(60000),

    get deltaHours() this._getDelta(3600000),

    get deltaDays() this._getDelta(86400000),

    get deltaYears() this._getDelta(31536000000),

    _getDelta: function RelativeDate__getDelta(aDivisor) {
        let current = Math.ceil(this.currentTime / aDivisor);
        let target = Math.ceil(this.targetTime / aDivisor);
        return current - target;
    }

}


Components.utils.import('resource://gre/modules/PluralForm.jsm');
let pluralRule = Services.strings.createBundle('chrome://brief/locale/brief.properties')
                                 .GetStringFromName('pluralRule');
let getPluralForm = PluralForm.makeGetter(pluralRule)[0];
