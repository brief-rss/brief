'use strict';

const T = {
    runTest: async function(name, fun) {
        try {
            let result = fun();
            if(result !== undefined && result.then !== undefined) {
                await result;
            }
            console.info(`  ${name}: success`);
        } catch(e) {
            console.error(`  ${name}: error -- `, e);
        }
    },

    runTests: async function(tests) {
        console.log("Starting test suite...");
        for (let name in tests) {
            await T.runTest(name, tests[name]);
        }
        console.log("Test suite finished");
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
