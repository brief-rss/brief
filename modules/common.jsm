const EXPORTED_SYMBOLS = ['IMPORT_COMMON', 'Cc', 'Ci', 'Cu', 'Task', 'log', 'extend',
                          'getPluralForm', 'RelativeDate'];

Components.utils.import('resource://gre/modules/Services.jsm');

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


function extend(aSubtype, aSupertype) {
    aSubtype.prototype.__proto__ = aSupertype.prototype;
}

function log(aMessage) {
    Services.console.logStringMessage(aMessage);
}


const ThreadManager = Cc['@mozilla.org/thread-manager;1'].getService(Ci.nsIThreadManager);

function defer(fn, ctx) {
    if (ctx) {
        fn = fn.bind(ctx);
    }
    ThreadManager.mainThread.dispatch(fn, 0);
}


function Task(aGeneratorFunction) {
    let generatorInstance = aGeneratorFunction.call(this, resume);
    resume();

    function resume() {
        try {
            let arg = arguments.length <= 1 ? arguments[0] : arguments;
            generatorInstance.send.call(generatorInstance, arg);
        }
        catch (ex if ex == StopIteration) {}
    }
}

Function.prototype.gen = function() {
    let generatorFunction = this;

    return function generatorWrapper() {
        let generatorInstance = generatorFunction.apply(this, arguments);
        resume();

        function resume() {
            try {
                generatorFunction.resume = resume;
                let arg = arguments.length <= 1 ? arguments[0] : arguments;
                generatorInstance.send.call(generatorInstance, arg);
            }
            catch (ex if ex == StopIteration) {}
            catch (ex if ex.name == "TypeError" && // Not instanceof - it's an 'object'
                   ex.message == "already executing generator") {
                defer(function() resume.apply(arguments));
            }
        }
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
