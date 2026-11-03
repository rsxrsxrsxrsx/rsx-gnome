// SPDX-License-Identifier: GPL-3.0-or-later
//
// A GNOME confirmation dialog for things that can lose work: quitting
// processes or force quitting an app.

import Clutter from 'gi://Clutter';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {_} from './i18n.js';

export function confirm({title, description, action, onConfirm}) {
    const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
    dialog.contentLayout.add_child(new Dialog.MessageDialogContent({title, description}));
    dialog.addButton({
        label: _('Cancel'),
        action: () => dialog.close(),
        key: Clutter.KEY_Escape,
    });
    const button = dialog.addButton({
        label: action,
        action: () => {
            dialog.close();
            onConfirm();
        },
        default: true,
    });
    button.add_style_class_name('destructive-action');
    dialog.open();
    return dialog;
}
