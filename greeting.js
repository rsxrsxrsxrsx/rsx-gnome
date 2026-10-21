// SPDX-License-Identifier: GPL-3.0-or-later
//
// "Good morning, Name" for the lock screen, by the time of day.

import GLib from 'gi://GLib';
import {_} from './i18n.js';

function firstName(user) {
    const real = (user?.get_real_name?.() || GLib.get_real_name() || '').trim();
    if (real && real !== 'Unknown')
        return real.split(/\s+/)[0];
    return user?.get_user_name?.() || GLib.get_user_name();
}

export function greetingText(user, name = '') {
    const hour = GLib.DateTime.new_now_local().get_hour();
    let text;
    if (hour >= 5 && hour < 12)
        text = _('Good morning');
    else if (hour >= 12 && hour < 17)
        text = _('Good afternoon');
    else if (hour >= 17 && hour < 23)
        text = _('Good evening');
    else
        text = _('Good night');
    return `${text}, ${name.trim() || firstName(user)}`;
}
