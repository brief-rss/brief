import {Prefs} from "/modules/prefs.js";
import {Database} from "/modules/database.js";
import {T} from "./_harness.js";


T.runTests('query', {
    zeroFilter: async () => {
        await Prefs.init();
        let db = await Database.init();
        let filters = db.query(0)._filters();
        T.assert_eq(
            filters.entry.id[0],
            0
        );
    },
});
