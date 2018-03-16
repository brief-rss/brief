'use strict';

T.runTests({
    parseDate: () => {
        T.assert_eq(
            parseDateValue("Fri, 16 Mar 2018 04:00:00 -0000"),
            new Date("2018-03-16T04:00:00.000Z").valueOf()
        );
    },
    parseSnippetGimp: async () => {
        let feed = await FeedFetcher.fetchFeed("snippets/gimp.xml");
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
