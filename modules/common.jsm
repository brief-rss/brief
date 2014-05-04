const EXPORTED_SYMBOLS = ['IMPORT_COMMON', 'Cc', 'Ci', 'Cu', 'log', 'wait',
                          'getPluralForm', 'RelativeDate'];

Components.utils.import('resource://gre/modules/Services.jsm');
Components.utils.import('resource://gre/modules/Task.jsm');
Components.utils.import('resource://gre/modules/commonjs/sdk/core/promise.js');

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

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
    let deferred = Promise.defer();

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
