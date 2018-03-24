'use strict';


T.runTests('query', {
    zeroFilter: () => {
        let filters = Database.query(0)._filters();
        T.assert_eq(
            filters.entry.id[0],
            0
        );
    },
});
