import {Prefs} from "/modules/prefs.js";
import {Database} from "/modules/database.js";
import {wait} from "/modules/utils.js";

const COUNT = 5000;

async function databaseUpdate() {
    await Prefs.init();
    let db = await Database.init();
    let oldDb = db._db;
    db._db = await db._open({
        name: "benchmark",
        version: this.DB_VERSION,
        upgrade: (event) => db._upgradeSchema({event}),
    });
    await db.loadFeeds();

    await db.addFeeds({
        url: 'https://127.12.34.56/',
        title: 'BENCHMARK',
    });
    await wait(200);
    let feed = db.feeds[0];
    let parsedFeed = {
        language: 'en',
        items: Array.from(new Array(COUNT).keys()).map(i => ({
            //id: 'entry-' + i,
            link: new URL('http://example.org/' + i),
        })),
    };
    let parsedFeedWithId = {
        language: 'en',
        items: Array.from(new Array(COUNT).keys()).map(i => ({
            id: 'entry-' + i,
            link: new URL('http://example.org/' + i),
        })),
    };
    let parsedFeedNext = {
        language: 'en',
        items: Array.from(new Array(COUNT).keys()).map(i => ({
            id: 'entry-' + (COUNT + i),
            link: new URL('http://example.org/' + (COUNT + i)),
        })),
    };
    let start;
    start = performance.now();
    console.log('starting insert');
    await db.pushUpdatedFeed({feed, parsedFeed});
    console.log(`insert done in ${performance.now() - start} ms`); // 1114
    start = performance.now();
    await db.pushUpdatedFeed({feed, parsedFeed});
    console.log(`link update done in ${performance.now() - start} ms`); // 2222
    start = performance.now();
    await db.pushUpdatedFeed({feed, parsedFeed: parsedFeedWithId});
    console.log(`link update to id done in ${performance.now() - start} ms`); // 2421
    start = performance.now();
    await db.pushUpdatedFeed({feed, parsedFeed: parsedFeedWithId});
    console.log(`id update done in ${performance.now() - start} ms`); // 2157
    start = performance.now();
    await db.pushUpdatedFeed({feed, parsedFeed: parsedFeedNext});
    console.log(`next insert done in ${performance.now() - start} ms`); // 1348
    start = performance.now();
    await db.query({}).markRead(true);
    console.log(`mark read done in ${performance.now() - start} ms`); // 1348

    console.log("done, restoring original");
    db._db = oldDb;
    await db.loadFeeds();
    await indexedDB.deleteDatabase("benchmark");
}
/* On battery:
insert done in 1328 ms benchmarks.js:46:13
link update done in 2414 ms benchmarks.js:49:13
link update to id done in 2904 ms benchmarks.js:52:13
id update done in 2362 ms benchmarks.js:55:13
next insert done in 1655 ms benchmarks.js:58:13
mark read done in 13629 ms benchmarks.js:61:13
done, restoring original
*/

window.Benchmarks = {
    databaseUpdate,
};
