const EXPORTED_SYMBOLS = ['IMPORT_COMMON'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

function IMPORT_COMMON(aScope) {
    aScope.Cc = Cc;
    aScope.Ci = Ci;
    aScope.Cu = Cu;

    aScope.log = function log(aMessage) {
        let consoleService = Cc['@mozilla.org/consoleservice;1']
                             .getService(Ci.nsIConsoleService);
        consoleService.logStringMessage(aMessage);
    }

    aScope.Array.prototype.__iterator__ = function() new ArrayIterator(this);

    aScope.Array.prototype.intersect = function intersect(aArr) {
        let commonItems = [];
        for (let i = 0; i < this.length; i++) {
            if (aArr.indexOf(this[i]) != -1)
                commonItems.push(this[i]);
        }
        return commonItems;
    }
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
