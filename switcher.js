// SPDX-License-Identifier: GPL-3.0-or-later
//
// Alt+Tab like Cmd+Tab on macOS: one big icon per app in a row on a dark
// background, with only the selected app's name shown. Windows of the same app
// are still reachable with Alt+` (or the arrow down key in the switcher).

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {AppSwitcherPopup} from 'resource:///org/gnome/shell/ui/altTab.js';

const BINDINGS = [
    'switch-windows', 'switch-windows-backward',
    'switch-applications', 'switch-applications-backward',
];

// Inside the popup, Alt+Tab arrives as "switch windows"; treat it as
// "switch applications" so Tab keeps moving between apps.
const ACTION_MAP = new Map([
    [Meta.KeyBindingAction.SWITCH_WINDOWS, Meta.KeyBindingAction.SWITCH_APPLICATIONS],
    [Meta.KeyBindingAction.SWITCH_WINDOWS_BACKWARD, Meta.KeyBindingAction.SWITCH_APPLICATIONS_BACKWARD],
]);

function decorate(popup) {
    popup.add_style_class_name('rsx-mac-switcher');
    const list = popup._switcherList;

    // Only the selected app's name is shown, under its icon.
    const icons = list.icons ?? [];
    const syncLabels = index => icons.forEach((icon, i) => {
        icon.label.opacity = i === index ? 255 : 0;
    });
    const highlight = list.highlight;
    list.highlight = function (index, justOutline) {
        highlight.call(this, index, justOutline);
        syncLabels(index);
    };
    syncLabels(-1);
}

export class MacSwitcher {
    enable() {
        const proto = AppSwitcherPopup.prototype;
        this._origKeyPress = proto._keyPressHandler;
        const origKeyPress = this._origKeyPress;
        proto._keyPressHandler = function (keysym, action) {
            return origKeyPress.call(this, keysym, ACTION_MAP.get(action) ?? action);
        };

        for (const name of BINDINGS) {
            Main.wm.setCustomKeybindingHandler(name, Shell.ActionMode.NORMAL,
                (_display, _window, _event, binding) => this._show(binding));
        }
    }

    _show(binding) {
        // Same as GNOME: never show two popups at once.
        Main.wm._workspaceSwitcherPopup?.destroy();

        const popup = new AppSwitcherPopup();
        decorate(popup);
        const backward = binding.is_reversed();
        const name = backward ? 'switch-applications-backward' : 'switch-applications';
        if (!popup.show(backward, name, binding.get_mask()))
            popup.destroy();
    }

    disable() {
        if (this._origKeyPress)
            AppSwitcherPopup.prototype._keyPressHandler = this._origKeyPress;
        this._origKeyPress = null;
        for (const name of BINDINGS) {
            Main.wm.setCustomKeybindingHandler(name, Shell.ActionMode.NORMAL,
                Main.wm._startSwitcher.bind(Main.wm));
        }
    }
}
