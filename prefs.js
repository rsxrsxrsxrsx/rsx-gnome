// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {buildGeneralGroup} from './wack/src/prefs/groups/generalGroup.js';
import {buildModeGroup} from './wack/src/prefs/groups/modeGroup.js';
import {buildDisplayPowerGroup} from './wack/src/prefs/groups/displayPowerGroup.js';
import {flushWackCache} from './wack/src/prefs/prefsUtils.js';
import {_, lockTranslator, setLanguage} from './i18n.js';

function checkRow(settings, key, title, subtitle) {
    const check = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
    settings.bind(key, check, 'active', Gio.SettingsBindFlags.DEFAULT);
    const row = new Adw.ActionRow({title, subtitle, activatable_widget: check});
    row.add_prefix(check);
    return row;
}

function group(page, title, description = null) {
    const g = new Adw.PreferencesGroup({title, description});
    page.add(g);
    return g;
}

export default class RsxPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 820);
        window.set_search_enabled(true);
        setLanguage(settings.get_string('language'));
        this._fillPages(window, settings);

        // A new language: build the pages again in it.
        settings.connect('changed::language', () => {
            setLanguage(settings.get_string('language'));
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                const visible = window.get_visible_page_name?.();
                for (const page of this._pages)
                    window.remove(page);
                this._fillPages(window, settings);
                if (visible)
                    window.set_visible_page_name(visible);
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _fillPages(window, settings) {
        this._pages = [this._desktopPage(settings), this._lockPage(window, settings)];
        this._pages[0].name = 'desktop';
        this._pages[1].name = 'lock';
        this._pages.forEach(page => window.add(page));
    }

    _languageGroup(page, settings) {
        const values = ['system', 'ru', 'en'];
        const row = new Adw.ComboRow({
            title: _('Language'),
            subtitle: _('Language of rsx: menus, settings, lock screen and the little runner'),
            model: Gtk.StringList.new([_('Same as the system'), 'Русский', 'English']),
            selected: Math.max(0, values.indexOf(settings.get_string('language'))),
        });
        row.connect('notify::selected', () => {
            const value = values[row.selected] ?? 'system';
            if (settings.get_string('language') !== value)
                settings.set_string('language', value);
        });
        group(page, _('Language')).add(row);
    }

    // -- Рабочий стол ---------------------------------------------------------

    _desktopPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Desktop'),
            icon_name: 'user-desktop-symbolic',
        });

        this._languageGroup(page, settings);

        const overview = group(page, _('Window overview'), _('What you see when you press Super'));
        overview.add(checkRow(settings, 'window-captions', _('Window captions'),
            _('Always show the icon and title under every window')));
        overview.add(checkRow(settings, 'equal-window-sizes', _('Same size windows'),
            _('All previews have the same height, rows line up evenly')));
        overview.add(checkRow(settings, 'spring-animation', _('Spring animation'),
            _('Smooth opening and closing with a light bounce')));

        const panel = group(page, _('Top bar'));
        panel.add(checkRow(settings, 'blur-panel', _('Blurred top bar'),
            _('Translucent top bar with the wallpaper blurred under it')));
        const scale = new Gtk.Scale({
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1, page_increment: 10}),
            digits: 0,
            draw_value: true,
            value_pos: Gtk.PositionType.LEFT,
            hexpand: true,
            valign: Gtk.Align.CENTER,
        });
        settings.bind('panel-blur-radius', scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        const blurRow = new Adw.ActionRow({title: _('Blur strength')});
        blurRow.add_suffix(scale);
        settings.bind('blur-panel', blurRow, 'sensitive', Gio.SettingsBindFlags.GET);
        panel.add(blurRow);

        const windows = group(page, _('Windows'));
        windows.add(checkRow(settings, 'center-windows', _('Open in the center'),
            _('New windows open in the middle of the screen with the mouse')));
        windows.add(checkRow(settings, 'spring-windows', _('Spring open and close'),
            _('Windows grow in with a light bounce and shrink away when closed')));

        const look = group(page, _('Appearance'));
        look.add(checkRow(settings, 'dynamic-island', _('Dynamic island'),
            _('A black pill at the top for music, notifications and volume, instead of banners and the volume popup')));
        look.add(checkRow(settings, 'shake-cursor', _('Shake to find the cursor'),
            _('Shake the mouse and the pointer grows big for a moment')));
        look.add(checkRow(settings, 'mac-osd', _('macOS-style volume popup'),
            _('A square with a big icon and a bar of segments for volume and brightness')));
        look.add(checkRow(settings, 'mac-switcher', _('macOS-style Alt+Tab'),
            _('Big app icons in a row; windows of one app with Alt+`')));
        look.add(checkRow(settings, 'screen-corners', _('Rounded screen corners'),
            _('Like on a MacBook display')));
        look.add(checkRow(settings, 'hide-world-clocks', _('No world clocks in the calendar'),
            _('Hide the "Add World Clocks…" button')));

        const runner = group(page, _('Little runner'));
        runner.add(checkRow(settings, 'runner', _('Little runner'),
            _('Lives on the desktop: runs, waves, can be dragged, thrown and hit with fast clicks')));
        runner.add(checkRow(settings, 'runner-speech', _('Talks'),
            _('Speech bubbles, and reminders to drink water, take a break and go to bed')));
        runner.add(checkRow(settings, 'runner-pranks', _('Pranks'),
            _('Sometimes drags a window a little')));
        runner.add(checkRow(settings, 'runner-sounds', _('Sounds'),
            _('Voice when hit, dropped or tickled')));

        const keyboard = group(page, _('Keyboard'));
        keyboard.add(checkRow(settings, 'latin-shortcuts', _('Shortcuts in any layout'),
            _('Ctrl+C, Ctrl+V, Ctrl+Shift+V and others work in the Russian layout in every app')));

        const clip = group(page, _('Clipboard'));
        clip.add(checkRow(settings, 'clipboard-history', _('Clipboard history'),
            _('Search copied text and images with a shortcut')));
        clip.add(checkRow(settings, 'clipboard-paste-on-select', _('Paste right away'),
            _('Paste the picked item into the active window (Ctrl+V, Ctrl+Shift+V in terminals)')));

        const maxRow = new Adw.SpinRow({
            title: _('How many to keep'),
            subtitle: _('The latest items; older ones are removed'),
            adjustment: new Gtk.Adjustment({lower: 5, upper: 500, step_increment: 5, page_increment: 50}),
        });
        settings.bind('clipboard-max-items', maxRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        clip.add(maxRow);

        const shortcutRow = new Adw.EntryRow({
            title: _('Shortcut (e.g. <Super>v)'),
            show_apply_button: true,
            text: settings.get_strv('clipboard-shortcut')[0] ?? '',
        });
        shortcutRow.connect('apply', () => {
            const accel = shortcutRow.text.trim();
            const [ok] = Gtk.accelerator_parse(accel);
            if (ok)
                settings.set_strv('clipboard-shortcut', [accel]);
            else
                shortcutRow.text = settings.get_strv('clipboard-shortcut')[0] ?? '';
        });
        clip.add(shortcutRow);

        const clearRow = new Adw.ActionRow({title: _('Clear history')});
        const clearButton = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        clearButton.connect('clicked', () =>
            settings.set_int('clipboard-clear-request', settings.get_int('clipboard-clear-request') + 1));
        clearRow.add_suffix(clearButton);
        clip.add(clearRow);

        [maxRow, shortcutRow].forEach(row =>
            settings.bind('clipboard-history', row, 'sensitive', Gio.SettingsBindFlags.GET));

        return page;
    }

    // -- Блокировка и вход ----------------------------------------------------

    _lockPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Lock & Login'),
            icon_name: 'system-lock-screen-symbolic',
        });
        const lockT = lockTranslator(this.path);

        const lock = group(page, _('Lock screen'));
        lock.add(checkRow(settings, 'cupertino-lock', _('macOS-style lock screen'),
            _('Clock at the top, avatar and password field at the bottom, blur while typing the password')));
        lock.add(checkRow(settings, 'english-on-lock', _('English layout'),
            _('Switch to English when locking, back to the previous layout after unlocking')));
        lock.add(checkRow(settings, 'lock-media', _('Now playing'),
            _('Big album cover with play controls when music is playing')));
        lock.add(checkRow(settings, 'lock-greeting', _('Greeting'),
            _('"Good morning, Name" above the avatar')));
        const nameRow = new Adw.EntryRow({
            title: _('Name in the greeting (empty: from the account)'),
            text: settings.get_string('greeting-name'),
        });
        nameRow.connect('changed', () => settings.set_string('greeting-name', nameRow.text.trim()));
        settings.bind('lock-greeting', nameRow, 'sensitive', Gio.SettingsBindFlags.GET);
        lock.add(nameRow);
        lock.add(checkRow(settings, 'lock-smoke', _('Smoke under the mouse'),
            _('Colourful smoke follows the pointer on the lock and login screens')));

        // Lock screen look settings (from the bundled lock screen module).
        const signalIds = [];
        const cleanups = [];
        const general = buildGeneralGroup(settings, window, lockT, signalIds);
        const mode = buildModeGroup(settings, window, lockT, signalIds, cleanups);
        const power = buildDisplayPowerGroup(settings, lockT, signalIds);
        general.group.title = _('Look');
        mode.group.title = _('Mode & animations');
        power.title = _('Display & power');
        for (const g of [general.group, mode.group, power]) {
            settings.bind('cupertino-lock', g, 'sensitive', Gio.SettingsBindFlags.GET);
            page.add(g);
        }

        // Linked buttons turn into dropdowns on narrow windows.
        const breakpoint = new Adw.Breakpoint({
            condition: Adw.BreakpointCondition.parse('max-width: 450px'),
        });
        breakpoint.add_setter(mode.linkedBox, 'visible', false);
        breakpoint.add_setter(mode.dropdown, 'visible', true);
        breakpoint.add_setter(general.dateStyleLinkedBox, 'visible', false);
        breakpoint.add_setter(general.dateStyleDropdown, 'visible', true);
        breakpoint.add_setter(mode.speedLinkedBox, 'visible', false);
        breakpoint.add_setter(mode.speedDropdown, 'visible', true);
        window.add_breakpoint(breakpoint);

        const login = group(page, _('Login screen'));
        login.add(checkRow(settings, 'cupertino-login', _('macOS-style login screen'),
            _('Your wallpaper, clock and avatars, like on the lock screen')));
        login.add(new Adw.ActionRow({
            title: _('System install'),
            subtitle: `${_('The login screen uses a copy of rsx: after changes run')}\nsudo ~/.local/share/gnome-shell/extensions/rsx@rsx/install-gdm.sh`,
            subtitle_selectable: true,
        }));

        const misc = group(page, _('Other'));
        const cacheRow = new Adw.ActionRow({
            title: _('Clear look cache'),
            subtitle: _('Removes temporary data used for the wallpaper and colour matching. It is rebuilt automatically.'),
        });
        const cacheButton = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        cacheButton.connect('clicked', () => {
            try {
                flushWackCache();
                window.add_toast(new Adw.Toast({title: _('Look cache cleared')}));
            } catch (e) {
                window.add_toast(new Adw.Toast({title: `${_("Couldn't clear the cache:")} ${e.message}`}));
            }
        });
        cacheRow.add_suffix(cacheButton);
        misc.add(cacheRow);

        window.connect('destroy', () => {
            signalIds.forEach(id => settings.disconnect(id));
            cleanups.forEach(fn => fn());
        });

        return page;
    }
}
