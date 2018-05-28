async function init() {
    apply_i18n(document);
    if (document.documentURI.match('tutorial')) {
        document.getElementById('header').style.display = 'none';
        document.getElementById('open-brief').style.display = 'none';
    }
}

window.addEventListener('load', () => init(), {once: true, passive: true});
