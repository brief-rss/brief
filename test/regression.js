import {Database} from "/modules/database.js";
import {T} from "./_harness.js";


T.runTests('regression', {
    entryWithoutLink: () => {
        let now = Date.now();
        let items = [{id: 'e0'}];
        Database._feedToEntries({feed: {feedID: 'ID'}, parsedFeed: {items}, now});
    },
});
