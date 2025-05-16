//@ts-strict
/**
 * Perform substitutions for i18n in text and attributes
 *
 * @param {Document} doc
 */
export function apply_i18n(doc) {
    for(let node of /** @type NodeListOf<HTMLElement> */(doc.querySelectorAll('[data-i18n]'))) {
        let id = /** @type string */(node.dataset.i18n);
        let text = browser.i18n.getMessage(id) || id;
        if(node.dataset.i18nAllowMarkup !== undefined) {
            node.insertAdjacentHTML('beforeend', text);
        } else {
            node.insertAdjacentText('beforeend', text);
        }
    }
    for(let node of /** @type NodeListOf<HTMLElement> */(doc.querySelectorAll('[data-i18n-attrs]'))) {
        let spec = /** @type string */(node.dataset.i18nAttrs);
        for(let substitution of spec.trim().split(/\s+/g)) {
            let [attr, text] = substitution.split(':');
            text = browser.i18n.getMessage(text) || text;
            node.setAttribute(attr, text);
        }
    }
}

// TODO: access key highlighting
