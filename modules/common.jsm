'use strict';

const EXPORTED_SYMBOLS = ['IMPORT_COMMON', 'Cc', 'Ci', 'log', 'wait',
                          'getPluralForm', 'RelativeDate', 'DataSource',
                          'BRIEF_URL'];

Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/Task.jsm');
Components.utils.import("resource://gre/modules/PromiseUtils.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;

function IMPORT_COMMON(aScope) {
    Object.defineProperty(aScope.Array.prototype, 'intersect', {
        value: Array.prototype.intersect,
        enumerable: false
    })

    Object.defineProperty(aScope.Function.prototype, 'task', {
        value: Function.prototype.task,
        enumerable: false
    })
}


const BRIEF_URL = 'chrome://brief/content/brief.xhtml';



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


/**
 * Returns a promise that resolves after the given time. The promise may be rejected
 * by calling its cancel() method.
 *
 * @param aDelay <integer>
 *        Time in milliseconds to wait. Default is 0, which means the promise will
 *        be resolved "as soon as possible" (but not synchronously).
 */
function wait(aDelay) {
    let deferred = PromiseUtils.defer();

    let timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
    timer.initWithCallback(() => deferred.resolve(), aDelay || 0, Ci.nsITimer.TYPE_ONE_SHOT);

    let cancel = () => {
        timer.cancel();
        deferred.reject('cancelled');
    };

    // Promise objects are sealed, so we cannot just add a 'cancel' method
    let promise = deferred.promise;
    return {
        'cancel': cancel,
        'then': promise.then.bind(promise)
    };
}


Function.prototype.task = function() {
    let generatorFunction = this;

    return function taskWrapper() {
        return Task.spawn(generatorFunction.apply(this, arguments));
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


function DataSource(initial) {
    this._data = initial;
    this._ports = new Set();
}

DataSource.prototype = {
    get: function() {
        return this._data;
    },

    set: function(value) {
        this._data = value;
        for(let port of this._ports) {
            port.postMessage(this._data);
        }
    },

    attach: function(port) {
        this._ports.add(port);
        port.postMessage(this._data);
    },

    detach: function(port) {
        this._ports.delete(port);
    },
}


Components.utils.import('resource://gre/modules/PluralForm.jsm');
let pluralRule = Services.strings.createBundle('chrome://brief/locale/brief.properties')
                                 .GetStringFromName('pluralRule');
let getPluralForm = PluralForm.makeGetter(pluralRule)[0];
