# Overview

Brief is an RSS reader extension for Firefox that attempts to make reading news feeds
(RSS/Atom for now) easy and intuitive. Your feeds should be available when you need them
and just work without forcing you to change every option in the world.

Brief is Free Software licensed under [MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/).

## Links and resources

Brief is published [on addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/brief/).

The official support and feedback channels are:
- [the Brief's channel on Gitter](https://gitter.im/brief-rss/Lobby),
- [the Brief topic on discourse.mozilla.org](https://discourse.mozilla.org/t/support-brief/6514),
- issues on the [main repository](https://github.com/brief-rss/brief).

For power users and people who want to contribute there are also:
- [testing versions released on Github](https://github.com/brief-rss/brief/releases),
- [the Brief development channel on Gitter](https://gitter.im/brief-rss/brief),
- issues and pull requests on the [main repository](https://github.com/brief-rss/brief).

If you want to help translate Brief into a language you know,
you can submit translation changes as pull requests manually
or use the [Web Extension Translator](https://lusito.github.io/web-ext-translator/?gh=https://github.com/brief-rss/brief/tree/master)
to help you with the messages file format.
There's a [separate Gitter room](https://gitter.im/brief-rss/localization)
for announcements about localization-related matters (new strings and other matters).

## Required permissions

Brief requires the following permissions:

- `<all_urls>` ("Access your data for all websites") to check the feeds you subscribe to
- `storage`/`unlimitedStorage` ("Store unlimited amount of client-side data") to store the items from your feeds
- `bookmarks` ("Read and modify bookmarks") to bookmark starred items and star your bookmarks
- `notifications` ("Display notifications to you") to tell you about new items found
- `contextMenus` (not displayed) to provide the Brief button context menu
- `tabs` ("Access browser tabs") to see subscribing via old subscription/preview pages
- `downloads` ("Download files and read and modify the browser's download history") to be able to export feed list and (not implemented yet) backup the database
- `webRequest` and `webRequestBlocking` (not displayed) to intercept the feed requests correctly and activate the feed preview mode instead of the download prompt

# Old-time contributors

## Creator

- Adam Kowalczyk

## Contributors

- Denis Lisov
- Leszek "teo" Życzkowski
- Christopher Finke
- Moritz Schallaböck
- Ngamer01
- Infocatcher
- nohamelin
- Tom Edwards
- Michael Eischer

Some of the icons courtesy of the talented Arvid Axelsson.

Some of the icons were made as part of the Tango Desktop Project.

Thanks to all the great people on #extdev at irc.mozilla.org: Christian Biesinger, Mark Finkle, Mook, Nickolay Ponomarev, Doron Rosenberg, Dave Townsend and Mike Shaver.

## Translators

- The Zero (cs)
- strepon (cs)
- AlleyKat (da)
- Joergen (da)
- Endor (de)
- Sonickydon (el)
- cmellib (es-ES)
- nico@nc (fr)
- Goofy (fr)
- lois (gl)
- Luana (it)
- Luca88 (it)
- drry (ja)
- arai (ja)
- mar (ja)
- markh (nl)
- micnic (ro-RO)
- Merlyel (ru-RU)
- Modex (ru-RU)
- tanriol (ru-RU)
- Jacen (sk-SK)
- Klofutar (sl-SI)
- alfapegasi (tr)
- YuriPet (uk-UA)
- xmoke (zh-CN)
- WangKing (zh-CN)
- Wayne Su (zh-TW)

and possibly others.
