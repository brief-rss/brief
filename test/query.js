import {Database} from "/scripts/database.js";
import {T} from "./_harness.js";


T.runTests('query', {
    zeroFilter: () => {
        let filters = Database.query(0)._filters();
        T.assert_eq(
            filters.entry.id[0],
            0
        );
    },
});
