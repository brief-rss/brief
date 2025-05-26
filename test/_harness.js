let queue = Promise.resolve();

let state = {
    container: document.getElementById("results"),
    name: "Overall test results",
    parent: null,
    total: 0,
    success: 0,
};

const C = {
    /** @param {string} name */
    group(name) {
        console.group(`Test suite: ${name}`);
        let container = document.createElement("details");
        state.container.append(container);
        state = {
            container,
            name,
            parent: state,
            total: 0,
            success: 0,
        };
    },
    groupEnd() {
        console.groupEnd();
        let groupState = state;
        state = state.parent;
        state.total += groupState.total;
        state.success += groupState.success;
        if(groupState.container.localName !== "details") {
            return;
        }
        let summary = document.createElement("summary");
        summary.textContent = `${groupState.name}: ${groupState.success}/${groupState.total} ok`;
        groupState.container.prepend(summary);
        let errors = groupState.total - groupState.success;
        groupState.container.toggleAttribute("open", errors);
        groupState.container.dataset.status = errors > 0 ? "bad" : "good";
    },
    pass(name) {
        console.log(`PASS ${name}`);
        let element = document.createElement("p");
        element.className = "test-result";
        element.textContent = name;
        element.dataset.status = "good";
        state.container.append(element);
        state.total += 1;
        state.success += 1;
    },
    fail(name, error) {
        console.error(`FAIL ${name}:`, error);
        let element = document.createElement("p");
        element.className = "test-result";
        element.textContent = `${name}: FAIL`;
        let specifics = document.createElement("pre");
        specifics.className = "error-details";
        element.append(specifics);
        specifics.textContent = error.toString();
        element.dataset.status = "bad";
        state.container.append(element);
        state.total += 1;
    },
};

export const T = {
    runTest: async function(name, fun) {
        try {
            let result = fun();
            if(result !== undefined && result.then !== undefined) {
                await result;
            }
            C.pass(name);
        } catch(e) {
            C.fail(name, e);
        }
    },

    runTests: async function(name, tests) {
        let promise = queue.then(() => T._runTests(name, tests)).catch(console.error);
        queue = promise;
        await promise;
    },

    _runTests: async function(name, tests) {
        C.group(name);
        for (let name in tests) {
            await T.runTest(name, tests[name]);
        }
        C.groupEnd();
    },

    assert: function(value) {
        if(!value) {
            throw `assert failed: ${value}`;
        }
    },

    assert_eq: function(left, right) {
        if(left !== right) {
            console.log('left: ', left);
            console.log('right:', right);
            throw `assert_eq failed:\nleft ${left}\nright ${right}`;
        }
    },
};
