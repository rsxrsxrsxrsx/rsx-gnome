// SPDX-License-Identifier: GPL-3.0-or-later
//
// Ctrl shortcuts in any layout: while Ctrl is held, the keyboard quietly
// switches to the Latin layout, so Ctrl+V, Ctrl+Shift+V, Ctrl+Z etc. reach
// every app as Latin keys, even ones that don't handle Ctrl+М themselves
// (JetBrains IDEs, Electron and Qt apps, some terminals). When Ctrl is
// released the previous layout comes back. The layout indicator doesn't
// change, because the input source itself stays the same.

import Clutter from 'gi://Clutter';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const LATIN_LAYOUTS = /^(us|gb)$/;

export class LatinShortcuts {
    enable() {
        this._switched = false;
        this._keymap = Clutter.get_default_backend().get_default_seat().get_keymap();
        // Fires on every modifier change, also while an app has focus.
        this._keymap.connectObject('state-changed', () => this._sync(), this);
    }

    _keyboardManager() {
        return getInputSourceManager()?.keyboardManager ?? null;
    }

    // Index of a Latin layout inside the current keymap, or -1.
    _latinIndex(current) {
        const group = current.group ?? [];
        const i = group.findIndex(info => LATIN_LAYOUTS.test(info?.layout ?? ''));
        if (i >= 0)
            return i;
        // GNOME appends the UI language layout after the user's ones.
        const locale = this._keyboardManager()?._localeLayoutInfo;
        return LATIN_LAYOUTS.test(locale?.layout ?? '') ? group.length : -1;
    }

    _sync() {
        const [, , mods] = global.get_pointer();
        const ctrl = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl === this._switched)
            return;

        const manager = this._keyboardManager();
        const current = manager?._current;
        if (!current || manager.isExternal())
            return;

        if (ctrl) {
            const latin = this._latinIndex(current);
            if (latin < 0 || latin === current.groupIndex)
                return;
            this._switched = true;
            this._setGroup(latin);
        } else {
            this._switched = false;
            this._setGroup(current.groupIndex);
        }
    }

    _setGroup(index) {
        const description = global.backend.get_keymap_description();
        if (!description)
            return;
        global.backend.set_keymap_async(description, index, null)
            .catch(e => console.error(`rsx@rsx: layout switch failed: ${e}`));
    }

    disable() {
        this._keymap?.disconnectObject(this);
        this._keymap = null;
        if (this._switched) {
            const current = this._keyboardManager()?._current;
            if (current)
                this._setGroup(current.groupIndex);
            this._switched = false;
        }
    }
}
