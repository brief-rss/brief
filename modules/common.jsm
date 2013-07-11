const EXPORTED_SYMBOLS = ['IMPORT_COMMON', 'Cc', 'Ci', 'Cu', 'Task', 'log', 'extend'];

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
            catch (ex if ex.name == "TypeError" && // Not instanceof - it's an 'object'
                   ex.message == "already executing generator") {
                defer(function() resume.apply(arguments));
            }
        }
    }
}
