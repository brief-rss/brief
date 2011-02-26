const EXPORTED_SYMBOLS = ['IMPORT_COMMON'];

function IMPORT_COMMON(aScope) {
    aScope.Cc = Components.classes;
    aScope.Ci = Components.interfaces;

    aScope.log = function log(aMessage) {
        let consoleService = Cc['@mozilla.org/consoleservice;1']
                             .getService(Ci.nsIConsoleService);
        consoleService.logStringMessage(aMessage);
    }

    aScope.Array.prototype.__iterator__ = function() new ArrayIterator(this);
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