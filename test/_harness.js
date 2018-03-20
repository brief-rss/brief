'use strict';

const T = {
    runTest: async function(name, fun) {
        try {
            let result = fun();
            if(result !== undefined && result.then !== undefined) {
                await result;
            }
            console.log(`PASS ${name}`);
        } catch(e) {
            console.error(`FAIL ${name}:`, e);
        }
    },

    runTests: async function(name, tests) {
        console.group(`Test suite: ${name}`);
        for (let name in tests) {
            await T.runTest(name, tests[name]);
        }
        console.groupEnd();
    },

    assert: function(value) {
        if(!value) {
            throw "assertion failed";
        }
    },

    assert_eq: function(left, right) {
        if(left !== right) {
            throw `assertion failed: ${left} === ${right}`;
        }
    },
};
