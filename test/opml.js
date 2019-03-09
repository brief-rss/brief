import {T} from "./_harness.js";
import {parse, serialize} from "/modules/opml.js";

T.runTests('OPML', {
    parser: () => {
        const data = `
            <opml>
                <body>
                    <outline xmlUrl="https://brief.example/feed1"/>
                    <outline text="Folder">
                        <outline xmlUrl="https://brief.example/feed2"/>
                        <outline xmlUrl="https://brief.example/nofeed" type="link"/>
                    </outline>
                </body>
            </opml>
        `;
        let results = parse(data);
        T.assert_eq(results.length, 2);
        T.assert_eq(results[0].url, "https://brief.example/feed1");
        T.assert_eq(results[0].children, undefined);
        T.assert_eq(results[1].url, undefined);
        T.assert_eq(results[1].children.length, 1);
    },
    serializer: () => {
        const data = [
            {parent: "0", isFolder: false, title: "feed", feedURL: "https://brief.example/feed1"}
        ];
        serialize(data);
    },
    // TODO: add a test for roundtripping the data (not easy due to list/tree format mismatch)
});
