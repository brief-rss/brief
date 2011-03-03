const EXPORTED_SYMBOLS = ['IMPORT_COMMON'];

Components.utils.import('resource://gre/modules/Services.jsm');

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

function IMPORT_COMMON(aScope) {
    aScope.Cc = Cc;
    aScope.Ci = Ci;
    aScope.Cu = Cu;

    aScope.log = log;

    aScope.Array.prototype.__iterator__ = Array.prototype.__iterator__;
    aScope.Array.prototype.intersect = Array.prototype.intersect;

    aScope.Task = Task;
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

function log(aMessage) {
    Services.console.logStringMessage(aMessage);
}


function Task(aGenerator) {
    let generator = aGenerator.call(this);

    this.resume = function(aReturnValue) {
        try {
            generator.send(aReturnValue);
        }
        catch (ex if ex == StopIteration) {}
    }

    try {
        generator.next();
    }
    catch (ex if ex == StopIteration) {}
}
