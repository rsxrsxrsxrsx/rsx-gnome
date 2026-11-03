// SPDX-License-Identifier: GPL-3.0-or-later
//
// The focused app on the left of the top bar, like the app menu on a Mac:
// its icon and name. A click lists its windows and offers a new window,
// closing all of them, and force quit for an app that hangs.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {_} from './i18n.js';
import {confirm} from './confirm.js';

const MAX_TITLE = 48;

export class AppMenu {
    enable() {
        this._button = new PanelMenu.Button(0.0, 'rsx app menu');
        this._button.add_style_class_name('rsx-appmenu');
        const box = new St.BoxLayout({style_class: 'rsx-appmenu-box'});
        this._icon = new St.Icon({style_class: 'rsx-appmenu-icon', y_align: Clutter.ActorAlign.CENTER});
        this._label = new St.Label({style_class: 'rsx-appmenu-label', y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(this._icon);
        box.add_child(this._label);
        this._button.add_child(box);

        const left = Main.panel._leftBox;
        Main.panel.addToStatusArea('rsx-appmenu', this._button, left.get_n_children(), 'left');

        this._tracker = Shell.WindowTracker.get_default();
        this._tracker.connectObject('notify::focus-app', () => this._sync(), this);
        Main.overview.connectObject(
            'showing', () => this._sync(),
            'hidden', () => this._sync(), this);
        global.window_manager.connectObject('switch-workspace', () => this._sync(), this);
        this._button.menu.connectObject('open-state-changed', (_m, open) => {
            if (open)
                this._fillMenu();
        }, this);
        this._sync();
    }

    _sync() {
        const app = this._tracker.focus_app;
        const show = !!app && !Main.overview.visible && !Main.sessionMode.isLocked;
        this._button.visible = show;
        if (app !== this._app) {
            this._app?.disconnectObject(this);
            this._app = app;
            app?.connectObject(
                'notify::state', () => this._sync(),
                'windows-changed', () => this._fillMenu(), this);
            // GNOME won't open an empty menu: fill it now, refresh on open.
            this._fillMenu();
        }
        if (!show) {
            this._button.menu.close();
            return;
        }
        this._icon.gicon = app.get_icon();
        this._label.text = app.get_name();
    }

    _fillMenu() {
        const menu = this._button.menu;
        menu.removeAll();
        const app = this._app;
        if (!app)
            return;

        // Its windows on every workspace, the focused one marked.
        const windows = app.get_windows().filter(w => !w.skip_taskbar);
        const focused = global.display.focus_window;
        for (const w of windows) {
            let title = w.get_title() || app.get_name();
            if (title.length > MAX_TITLE)
                title = `${title.slice(0, MAX_TITLE)}…`;
            const item = new PopupMenu.PopupMenuItem(title);
            if (w === focused)
                item.setOrnament(PopupMenu.Ornament.DOT);
            else
                item.setOrnament(PopupMenu.Ornament.NONE);
            item.connect('activate', () => Main.activateWindow(w));
            menu.addMenuItem(item);
        }
        if (windows.length)
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (app.can_open_new_window())
            menu.addAction(_('New Window'), () => app.open_new_window(-1));
        const info = app.get_app_info();
        if (info) {
            for (const action of info.list_actions?.() ?? []) {
                if (/new-window|new_window|newwindow/i.test(action))
                    continue; // already above
                menu.addAction(info.get_action_name(action), () => app.launch_action(action, 0, -1));
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (windows.length > 1)
            menu.addAction(_('Close All Windows'), () => this._closeAll(app));
        else
            menu.addAction(_('Quit'), () => this._closeAll(app));
        const pids = app.get_pids();
        if (pids.length)
            menu.addAction(_('Force Quit'), () => confirm({
                title: _('Force quit “%s”?').replace('%s', app.get_name()),
                description: _('The app is stopped at once, without saving. Use this when it hangs.'),
                action: _('Force Quit'),
                onConfirm: () => this._forceQuit(pids),
            }));
    }

    _closeAll(app) {
        const time = global.get_current_time();
        for (const w of app.get_windows())
            w.delete(time);
    }

    _forceQuit(pids) {
        try {
            Gio.Subprocess.new(['kill', '-KILL', ...pids.map(String)], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.warn(`rsx@rsx: force quit: ${e.message}`);
        }
    }

    disable() {
        this._tracker?.disconnectObject(this);
        this._app?.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        this._button?.menu.disconnectObject(this);
        this._button?.destroy();
        this._button = this._app = this._tracker = null;
    }
}
