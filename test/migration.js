import {Migrator} from "/scripts/database.js";
import {T} from "./_harness.js";

const FEED_A = {
    feedID: 'a',
    lastUpdated: 0,
    isFolder: 0,
    feedURL: 'http://a.a',
    hidden: 0,
    parent: null,
    rowIndex: 1,
};

const FEED_B = {
    feedID: 'b',
    lastUpdated: 0,
    feedURL: 'http://b.b',
    hidden: 0,
    parent: null,
    rowIndex: 1,
};

const FOLDER_A = {
    feedID: '1',
    isFolder: 1,
    hidden: 0,
    parent: null,
    rowIndex: 1,
};

function verify(src, dst, expected) {
    let result = Migrator.mergeFeeds({src, dst});
    T.assert_eq(
        result.feeds.length,
        expected.feeds.length,
    );
    for(let [r, e] of result.feeds.map((r, i) => [r, expected.feeds[i]])) {
        T.assert_eq(
            JSON.stringify(Object.entries(r).sort()),
            JSON.stringify(Object.entries(e).sort()),
        );
    }
    T.assert_eq(
        JSON.stringify(Array.from(result.feedMap).sort()),
        JSON.stringify(Object.entries(expected.feedMap).sort()),
    );
}

T.runTests('mergeFeeds', {
    empty: () => {
        verify(
            [],
            [],
            {feeds: [], feedMap: {}}
        );
    },
    sameFeed: () => {
        verify(
            [FEED_A],
            [FEED_A],
            {feeds: [FEED_A], feedMap: {a: 'a'}}
        );
    },
    sameButDifferentId: () => {
        verify(
            [FEED_A],
            [{...FEED_A, feedID: 'aaa'}],
            {feeds: [{...FEED_A, feedID: 'aaa'}], feedMap: {a: 'aaa', aaa: 'aaa'}}
        );
    },
    mergeProperties: () => {
        verify(
            [{...FEED_A, t1: 's', t2: 's', lastUpdated: 1000}],
            [{...FEED_A, t2: 'd', t3: 'd'}],
            {
                feeds: [{...FEED_A, t1: 's', t2: 's', t3: 'd', lastUpdated: 1000}],
                feedMap: {a: 'a'},
            }
        );
        verify(
            [{...FEED_A, t1: 's', t2: 's'}],
            [{...FEED_A, t2: 'd', t3: 'd', lastUpdated: 1000}],
            {
                feeds: [{...FEED_A, t1: 's', t2: 'd', t3: 'd', lastUpdated: 1000}],
                feedMap: {a: 'a'},
            }
        );
    },
    keepAllFeeds: () => {
        verify(
            [FEED_A],
            [FEED_B],
            {
                feeds: [FEED_B, {...FEED_A, rowIndex: 2}],
                feedMap: {a: 'a', b: 'b'},
            }
        );
    },
    keepFolders: () => {
        verify(
            [FOLDER_A, {...FEED_A, parent: '1', rowIndex: 2, lastUpdated: 1000}],
            [FOLDER_A, {...FEED_B, parent: '1', rowIndex: 2}],
            {
                feeds: [
                    FOLDER_A,
                    {...FEED_A, rowIndex: 2, lastUpdated: 1000, parent: '1'},
                    {...FOLDER_A, feedID: '2', rowIndex: 3},
                    {...FEED_B, rowIndex: 4, parent: '2'},
                ],
                feedMap: {a: 'a', b: 'b'},
            }
        );
        verify(
            [FOLDER_A, {...FEED_A, parent: '1', rowIndex: 2, lastUpdated: 1000}],
            [FOLDER_A, {...FEED_A, parent: '1', rowIndex: 2}],
            {
                feeds: [
                    FOLDER_A,
                    {...FEED_A, rowIndex: 2, lastUpdated: 1000, parent: '1'},
                ],
                feedMap: {a: 'a'},
            }
        );
    },
    // TODO: add more test cases for different variations here
    complex: () => {
        let main = [
            FOLDER_A,
            // This one will be hidden
            {...FEED_A, parent: '1', rowIndex: 2, lastUpdated: 1000, hidden: 0},
            // This one will be shown
            {...FEED_B, parent: '1', rowIndex: 3, lastUpdated: 1000, hidden: 2000},
        ];
        let extras = [
            FOLDER_A,
            // This is the latest version, and it's hidden
            {...FEED_A, parent: '1', rowIndex: 7, lastUpdated: 1500, hidden: 3000},
            // Updated after last hidden
            {...FEED_B, parent: '1', rowIndex: 3, lastUpdated: 2500, hidden: 0},
        ];
        let expectedList = [
            FOLDER_A,
            {...FEED_A, parent: '1', rowIndex: 7, lastUpdated: 1500, hidden: 3000},
            {...FEED_B, parent: '1', rowIndex: 3, lastUpdated: 2500, hidden: 0},
        ];
        verify(
            main,
            extras,
            {
                feeds: expectedList,
                feedMap: {a: 'a', b: 'b'},
            }
        );
    },
});
