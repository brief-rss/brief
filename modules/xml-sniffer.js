'use strict';

/*
 * Implementation notes
 *
 * This module intentionally does not validate markup completely, doing just enough validation
 * to correctly understand nesting.
 *
 * According to my benchmarking, a single regex is slightly faster than functions calling regex
 * (110 vs 130 ns/iter for HTML, 600 vs 900 for xhtml with a 512-byte fragment).
 *
 * Non-capturing groups are *important* for perf (with all captures time roughly triples),
 */

const raw = String.raw; // Just a shortcut for building regexp in this file

const S = raw`[ \t\r\n]`;
const DQ = raw`"[^"]*"`;
const SQ = raw`'[^']*'`;

const ASCII_NAME = raw`[:a-zA-Z_][:a-zA-Z_0-9.-]*`;
const SKIP_ATTRS = raw`(?:${SQ}|${DQ}|[^'">]+)*`;
const PE_REF = raw`%${ASCII_NAME};`;

const COMMENT = raw`<!--(-?[^-]+)*-->`;
const PI = raw`<\?(?:\??[^>]+)*\?>`;

const XML_DECL = raw`<\?xml${S}+version${S}*=${S}*(?:'1\.[0-9]+'|"1\.[0-9]+")[^?]*\?>`;
const MISC_ITEM = raw`(?:${S}+|${COMMENT}|${PI})`;

//const DOCTYPE = raw`<!DOCTYPE${S}+(?:${SQ}|${DQ}|[^'"[>]+)+>`;
const DECL_SEP_CASES = raw`${S}|${PE_REF}`;
const MARKUP_DECL_TAG = raw`<!(?:ELEMENT|ATTLIST|ENTITY|NOTATION)${SKIP_ATTRS}>`;
const MARKUP_DECL_CASES = raw`${PI}|${COMMENT}|${MARKUP_DECL_TAG}`;
const INT_DOCTYPE = raw`(?:${MARKUP_DECL_CASES}|${DECL_SEP_CASES})*`;
const DOCTYPE = raw`<!DOCTYPE${S}+(?:${SQ}|${DQ}|[^'"[>]+)+(?:\[${INT_DOCTYPE}\]${S}*)?>`;

const PROLOG = raw`${XML_DECL}${MISC_ITEM}*(?:${DOCTYPE}${MISC_ITEM}*)?`;

const PROLOG_RE = new RegExp(raw`^${PROLOG}`);

export function tryGetXmlRootName(text) {
    let match = PROLOG_RE.exec(text);
    if(match !== null) {
        text = text.slice(match[0].length);
    } else {
        return null;
    }

    const XML_ELEMENT_ASCII = (
        /^<([:a-zA-Z_][:a-zA-Z_0-9.-]*)/
    );
    match = XML_ELEMENT_ASCII.exec(text);
    if(match !== null) {
        return match[1];
    }
    return null;
}
