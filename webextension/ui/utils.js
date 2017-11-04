// This file should be in /scripts, but chrome:// has no access to that directory

// ===== Promise utilities =====

// Adapt setTimeout for Promises
function wait(delay) {
    return new Promise(resolve => setTimeout(() => resolve(), delay));
}

// Wait for a specific event (for example, 'transitionend')
function expectedEvent(element, event) {
    return new Promise((resolve, reject) => {
        element.addEventListener(resolve, {once: true, passive: true});
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
