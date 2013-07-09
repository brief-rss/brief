const EXPORTED_SYMBOLS = ['IMPORT_COMMON', 'Cc', 'Ci', 'Cu', 'Task', 'log', 'extend',
                          'getPluralForm', 'RelativeDate'];

Components.utils.import('resource://gre/modules/Services.jsm');

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

function IMPORT_COMMON(aScope) {
    aScope.Array.prototype.__iterator__ = Array.prototype.__iterator__;
    aScope.Array.prototype.intersect = Array.prototype.intersect;

    aScope.Function.prototype.gen = Function.prototype.gen;
}


function ArrayIterator(aArray) {
    this.array = aArray;
    this.currentIndex = 0;
}

ArrayIterator.prototype.next = function() {
    if (this.currentIndex < this.array.length)
        return this.array[this.currentIndex++];
    else
        throw StopIteration;
}

Array.prototype.__iterator__ = function() new ArrayIterator(this);

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


function Task(aGeneratorFunction) {
    let generatorInstance = aGeneratorFunction.call(this, resume);
    resume();

    function resume() {
        try {
            generatorInstance.send.apply(generatorInstance, arguments);
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
