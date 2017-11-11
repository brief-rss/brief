// Perform substitutions for i18n in text and attributes
function apply_i18n(doc) {
    for(let node of document.querySelectorAll('[data-i18n]')) {
        text = browser.i18n.getMessage(node.dataset.i18n) || node.dataset.i18n;
        node.appendChild(document.createTextNode(text));
    }
    for(let node of document.querySelectorAll('[data-i18n-attrs]')) {
        for(let substitution of node.dataset.i18nAttrs.split(/\s+/g)) {
            let [attr, text] = substitution.split(':');
            text = browser.i18n.getMessage(text);
            node[attr] = text;
        }
    }
}
