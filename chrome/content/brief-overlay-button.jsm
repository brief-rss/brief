'use strict';

const EXPORTED_SYMBOLS = ['briefButton'];

Components.utils.import("resource://gre/modules/Console.jsm");
Components.utils.import("resource:///modules/CustomizableUI.jsm");

const BRIEF_BUTTON_ID = "brief-button";

function BriefButton() {
    this.created = false;
}

BriefButton.prototype = {
    create: function BriefButton_create(updateStatusCb) {
        if (this.created) {
            return;
        }

        // only register once
        let briefButton = CustomizableUI.createWidget({
            id: BRIEF_BUTTON_ID,
            type: "button",
            label: "Brief",
            tooltiptext: "",
            onCreated: (node) => {
                // mark as badged button
                node.setAttribute('class', "toolbarbutton-1 chromeclass-toolbar-additional badged-button");
                // set our tooltip and contextmenu
                node.removeAttribute("tooltiptext");
                node.setAttribute('tooltip', "brief-tooltip");
                node.setAttribute('context', "brief-status-context");
                // update badge
                updateStatusCb(node);
            },
            onClick: (event) => {
                if (event.button == 0 || event.button == 1) event.view.Brief.open();
            },
        });

        CustomizableUI.addListener({
            onCustomizeEnd: () => {
                updateStatusCb();
            }
        });
        this.created = true;
    },

    addToToolbar: function BriefButton_addToToolbar() {
        CustomizableUI.addWidgetToArea(BRIEF_BUTTON_ID, CustomizableUI.AREA_NAVBAR);
    },

    forWindow: function BriefButton_forWindow(window) {
        return window.document.getElementById(BRIEF_BUTTON_ID);
    },
};

// singleton
var briefButton = new BriefButton();
