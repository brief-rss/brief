import {Database} from "/modules/database.js";
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
        Database._feedToEntries({feed: {feedID: "feedid"}, parsedFeed: feed, now: Date.now()});
    },
    async snippetRss091NetscapeWithEntities() {
        let feed = await fetchFeed(new URL("snippets/rss-0.91-netscape-with-entities.xml", document.location.href));
        T.assert_eq(feed.title, "Scripting News\u{2014}example");
        T.assert_eq(feed.updated, "Thu, 08 Jul 1999 07:00:00 GMT");
        T.assert_eq(feed.link.href, "http://www.scripting.com/");
        T.assert_eq(feed.subtitle, "News and commentary from the cross-platform scripting community.");

        let item = feed.items[0];
        T.assert_eq(item.title, "stuff");
        T.assert_eq(item.link.href, "http://bar/");
        T.assert_eq(item.summary, "This is an article about some stuff");
        T.assert_eq(item.id, null);
        Database._feedToEntries({feed: {feedID: "feedid"}, parsedFeed: feed, now: Date.now()});
    },
    async snippetDsa() {
        let feed = await fetchFeed(new URL("snippets/rdf-from-dsa.xml", document.location.href));
        console.log(feed);
        T.assert_eq(feed.title, "Debian Security");
        T.assert_eq(feed.updated, "Sun, 28 Sep 2025 07:33:01 GMT");
        T.assert_eq(feed.link.href, "https://www.debian.org/security/dsa.rdf");
        T.assert_eq(feed.subtitle, "Debian Security Advisories");

        T.assert(feed.items.length > 0);
        let item = feed.items[0];
        T.assert_eq(item.title, "DSA-6012-1 nncp - security update");
        T.assert_eq(item.link.href, "https://lists.debian.org/debian-security-announce/2025/msg00177.html");
        T.assert_eq(item.summary, '<a href="https://security-tracker.debian.org/tracker/DSA-6012-1">https://security-tracker.debian.org/tracker/DSA-6012-1</a>');
        T.assert_eq(item.published, null);
        T.assert_eq(item.id, "https://lists.debian.org/debian-security-announce/2025/msg00177.html");
    },
});
