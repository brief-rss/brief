import {fetchFeed} from "/modules/feed-fetcher.js";
import {parseDateValue} from "/modules/utils.js";
import {T} from "./_harness.js";


T.runTests('parse', {
    date: () => {
        T.assert_eq(
            parseDateValue("Fri, 16 Mar 2018 04:00:00 -0000"),
            new Date("2018-03-16T04:00:00.000Z").valueOf()
        );
    },
    snippetGimp: async () => {
        let feed = await fetchFeed(new URL("snippets/gimp.xml", document.location.href));
        T.assert_eq(feed.title, "FEED_TITLE");
        T.assert_eq(feed.updated, "Mon, 01 Jan 2018 12:00:00 GMT");
        T.assert_eq(feed.link.href, "https://rss.example/site");
        T.assert_eq(feed.subtitle, "FEED_SUBTITLE");

        let item = feed.items[0];
        T.assert_eq(item.title, "ITEM_TITLE");
        T.assert_eq(item.link.href, "https://rss.example/item");
        T.assert_eq(item.summary, "ITEM_SUMMARY");
        T.assert_eq(item.authors[0], "AUTHOR");
        T.assert_eq(item.published, "Mon, 01 Jan 2018 08:00:00 GMT");
        T.assert_eq(item.id, "tag:id");
    },
});
