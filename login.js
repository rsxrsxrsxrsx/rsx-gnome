// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cupertino login screen (GDM), in the same style as the WACK lock screen.
//
// The greeter runs as the "gdm" user and can't read the user's home, so this
// has two halves:
//  - user session: export the current wallpaper (path + options) to
//    /var/tmp/rsx-login/<user>.json, copying the image there if it lives
//    somewhere gdm can't read;
//  - greeter: show that wallpaper, the WACK clock at the top, users as a row
//    of avatars at the bottom, the password pill under the selected avatar,
//    and blur the wallpaper while the password prompt is open.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import {LoginDialog} from 'resource:///org/gnome/shell/gdm/loginDialog.js';

import {WackClock} from './wack/src/main/wackClock.js';
import {SmokeActor} from './smoke.js';

const LOGIN_DIR = '/var/tmp/rsx-login';

const CLOCK_TOP = 0.07; // fraction of screen height
const USERS_TOP = 0.66; // where the avatar row / password prompt starts
const CLOCK_ALPHA = 0.85;
const PROMPT_BLUR = 40;
const PROMPT_BRIGHTNESS = 0.85;
const FADE_TIME = 300;
const USER_ITEM_PADDING = 10; // matches padding-top of the list item in stylesheet.css

// ---------------------------------------------------------------------------
// User session: export the wallpaper for the greeter
// ---------------------------------------------------------------------------

function setMode(path, mode) {
    try {
        Gio.File.new_for_path(path).set_attribute_uint32('unix::mode', mode,
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        // Not ours (another user created it): fine, as long as it's usable.
    }
}

function ensureLoginDir() {
    GLib.mkdir_with_parents(LOGIN_DIR, 0o1777);
    // Sticky and world-writable like /tmp, so every user can publish
    // their own file; umask may have dropped bits, so set them explicitly.
    setMode(LOGIN_DIR, 0o1777);
}

function writeFile(path, bytes) {
    const file = Gio.File.new_for_path(path);
    file.replace_contents(bytes, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    setMode(path, 0o644);
}

// GSettings may store colors as #rrrrggggbbbb; CSS wants #rrggbb.
function cssColor(color) {
    if (/^#[0-9a-f]{12}$/i.test(color))
        return `#${color.slice(1, 3)}${color.slice(5, 7)}${color.slice(9, 11)}`;
    return /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#000000';
}

class WallpaperExport {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        this._bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const sync = () => this._export();
        this._bg.connectObject(
            'changed::picture-uri', sync,
            'changed::picture-uri-dark', sync,
            'changed::picture-options', sync,
            'changed::primary-color', sync,
            this);
        this._iface.connectObject('changed::color-scheme', sync, this);
        this._settings.connectObject('changed::date-style', sync, this);
        this._export();
    }

    _export() {
        try {
            ensureLoginDir();
            const user = GLib.get_user_name();
            const dark = this._iface.get_string('color-scheme') === 'prefer-dark';
            const uri = this._bg.get_string(dark ? 'picture-uri-dark' : 'picture-uri') ||
                this._bg.get_string('picture-uri');

            let wallpaper = uri ? Gio.File.new_for_uri(uri).get_path() : null;
            if (wallpaper && (!GLib.file_test(wallpaper, GLib.FileTest.EXISTS) ||
                              wallpaper.endsWith('.xml')))
                wallpaper = null;

            // gdm can't read the home folder: publish a copy.
            if (wallpaper && wallpaper.startsWith(`${GLib.get_home_dir()}/`)) {
                const ext = wallpaper.split('.').pop().toLowerCase();
                const copy = `${LOGIN_DIR}/${user}-wallpaper.${ext}`;
                const [, bytes] = GLib.file_get_contents(wallpaper);
                writeFile(copy, bytes);
                wallpaper = copy;
            }

            const manifest = {
                user,
                wallpaper,
                options: this._bg.get_string('picture-options'),
                primaryColor: cssColor(this._bg.get_string('primary-color')),
                // Same date look as on the lock screen (WACK setting).
                dateStyle: this._settings.get_string('date-style'),
                updated: GLib.get_real_time(),
            };
            writeFile(`${LOGIN_DIR}/${user}.json`,
                new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
        } catch (e) {
            console.warn(`rsx@rsx: couldn't export wallpaper for the login screen: ${e.message}`);
        }
    }

    disable() {
        this._settings.disconnectObject(this);
        this._bg.disconnectObject(this);
        this._iface.disconnectObject(this);
        this._bg = this._iface = null;
    }
}

// ---------------------------------------------------------------------------
// Greeter
// ---------------------------------------------------------------------------

function readManifest(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

// Manifest of the given user, or the most recently updated one.
function findManifest(userName = null) {
    if (userName) {
        const m = readManifest(`${LOGIN_DIR}/${userName}.json`);
        if (m)
            return m;
    }
    let best = null;
    try {
        const dir = Gio.File.new_for_path(LOGIN_DIR);
        const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = children.next_file(null))) {
            const name = info.get_name();
            if (!name.endsWith('.json'))
                continue;
            const m = readManifest(`${LOGIN_DIR}/${name}`);
            if (m && (!best || m.updated > best.updated))
                best = m;
        }
    } catch {
        // No directory yet: nobody has logged in with rsx.
    }
    return best;
}

const BACKGROUND_SIZE = {
    zoom: 'cover',
    spanned: 'cover',
    scaled: 'contain',
    centered: 'auto',
    stretched: '100% 100%',
    wallpaper: 'auto',
};

class GreeterLook {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        this._patchLayout();
        const dialog = Main.screenShield?._dialog;
        if (dialog instanceof LoginDialog) {
            this._setup(dialog);
        } else {
            Main.layoutManager.connectObject('startup-complete', () => {
                const d = Main.screenShield?._dialog;
                if (d instanceof LoginDialog && !this._dialog)
                    this._setup(d);
            }, this);
        }
    }

    // Avatar row and password prompt sit low on the screen, not centered.
    _patchLayout() {
        const proto = LoginDialog.prototype;
        this._origCenterAlloc = proto._getCenterActorAllocation;
        const orig = this._origCenterAlloc;
        proto._getCenterActorAllocation = function (dialogBox, actor) {
            const box = orig.call(this, dialogBox, actor);
            if (!this._rsxLogin)
                return box;
            const height = box.y2 - box.y1;
            let top = dialogBox.y1 + Math.floor((dialogBox.y2 - dialogBox.y1) * USERS_TOP);
            // Line the list's avatars up with the prompt's avatar
            // (list items have padding around the avatar).
            if (actor === this._userSelectionBox) {
                const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
                top -= USER_ITEM_PADDING * scaleFactor;
            }
            box.y1 = top;
            box.y2 = top + height;
            return box;
        };
    }

    _setup(dialog) {
        try {
            this._dialog = dialog;
            dialog._rsxLogin = true;
            dialog.add_style_class_name('rsx-login');

            this._createBackground(findManifest());
            this._createClock();
            this._createSmoke();
            this._setupUserList(dialog);

            // Blur the wallpaper while the password prompt is open.
            dialog._authPrompt.connectObject('notify::visible',
                () => this._syncBlur(true), this);
            this._syncBlur(false);

            // Show the selected user's own wallpaper.
            dialog._authPrompt.connectObject('reset', () => this._syncUserWallpaper(), this);
            dialog._userList.connectObject('activate', (_list, item) =>
                this._updateBackground(findManifest(item.user.get_user_name())), this);

            // Our big clock replaces the panel clock; no distro logo.
            Main.panel.statusArea.dateMenu?.container.hide();
            dialog._logoBin.opacity = 0;

            Main.layoutManager.connectObject('monitors-changed', () => {
                this._updateBackground(this._manifest);
                this._positionClock();
            }, this);

            dialog.queue_relayout();
        } catch (e) {
            console.error(`rsx@rsx: login screen setup failed, using stock: ${e}\n${e.stack}`);
            this._teardown();
        }
    }

    _syncUserWallpaper() {
        const user = this._dialog?._user;
        if (user)
            this._updateBackground(findManifest(user.get_user_name()));
    }

    // -- wallpaper -----------------------------------------------------------

    _createBackground(manifest) {
        this._bgGroup = new Clutter.Actor();
        const group = Main.screenShield._lockDialogGroup;
        group.insert_child_below(this._bgGroup, this._dialog);
        this._updateBackground(manifest);
    }

    _updateBackground(manifest) {
        if (!this._bgGroup)
            return;
        this._manifest = manifest;
        this._bgGroup.destroy_all_children();

        if (!manifest?.wallpaper || !GLib.file_test(manifest.wallpaper, GLib.FileTest.EXISTS))
            return; // keep GDM's own background

        const size = BACKGROUND_SIZE[manifest.options] ?? 'cover';
        const color = cssColor(manifest.primaryColor ?? '');
        this._clock?.setDateStyle(manifest.dateStyle ?? 'full');
        const file = Gio.File.new_for_path(manifest.wallpaper);
        for (const monitor of Main.layoutManager.monitors) {
            const widget = new St.Widget({
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                style: `background-color: ${color};
                        background-image: url("${file.get_uri()}");
                        background-size: ${size};`,
            });
            widget.add_effect_with_name('blur', new Shell.BlurEffect({
                mode: Shell.BlurMode.ACTOR,
                radius: 0,
                brightness: 1,
            }));
            this._bgGroup.add_child(widget);
        }
        this._syncBlur(false);
    }

    _syncBlur(animate) {
        if (!this._bgGroup || !this._dialog)
            return;
        const open = this._dialog._authPrompt.visible;
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const radius = open ? PROMPT_BLUR * scaleFactor : 0;
        const brightness = open ? PROMPT_BRIGHTNESS : 1;

        for (const widget of this._bgGroup) {
            const effect = widget.get_effect('blur');
            if (!effect)
                continue;
            if (animate) {
                widget.ease_property('@effects.blur.radius', radius, {duration: FADE_TIME});
                widget.ease_property('@effects.blur.brightness', brightness, {duration: FADE_TIME});
            } else {
                effect.set({radius, brightness});
            }
        }
    }

    // -- clock ---------------------------------------------------------------

    _createClock() {
        this._clockBin = new St.Bin({
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
        });
        this._clockBin.add_constraint(new Layout.MonitorConstraint({primary: true}));
        this._clock = new WackClock();
        this._clock.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START});
        this._clock.setWallpaperAlpha(CLOCK_ALPHA);
        this._clock.setDateStyle(this._manifest?.dateStyle ?? 'full');
        this._clockBin.set_child(this._clock);
        Main.screenShield._lockDialogGroup.insert_child_above(this._clockBin, this._bgGroup);
        this._positionClock();
    }

    _positionClock() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (this._clockBin && monitor)
            this._clockBin.set_style(`padding-top: ${Math.round(monitor.height * CLOCK_TOP)}px;`);
    }

    // -- smoke under the mouse, like on the lock screen ----------------------

    _createSmoke() {
        if (!this._settings.get_boolean('lock-smoke'))
            return;
        this._smoke = new SmokeActor();
        this._smoke.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        const group = Main.screenShield._lockDialogGroup;
        group.insert_child_above(this._smoke, this._bgGroup);
        group.connectObject('captured-event', (_a, event) => {
            if (event.type() === Clutter.EventType.MOTION)
                this._smoke?.pointerMoved(...event.get_coords());
            return Clutter.EVENT_PROPAGATE;
        }, this);
    }

    // -- user list: a row of avatars -----------------------------------------

    _setupUserList(dialog) {
        const box = dialog._userList._box;
        box.orientation = Clutter.Orientation.HORIZONTAL;
        box.x_align = Clutter.ActorAlign.CENTER;
        dialog._userList.set({hscrollbar_policy: St.PolicyType.NEVER});
        box.connectObject('child-added', (_box, item) => this._makeVertical(item), this);
        for (const item of box)
            this._makeVertical(item);

        // No "Not listed?" link under the avatars: GNOME shows it every
        // time the list appears, so hide it again whenever it's shown.
        const notListed = dialog._notListedButton;
        notListed.connectObject('notify::visible', () => {
            if (notListed.visible)
                notListed.hide();
        }, this);
        notListed.hide();
    }

    _makeVertical(item) {
        const widget = item._userWidget;
        if (!widget || widget._rsxVertical)
            return;
        widget._rsxVertical = true;
        widget.orientation = Clutter.Orientation.VERTICAL;
        widget.remove_style_class_name('horizontal');
        widget.add_style_class_name('vertical');
        widget.x_align = Clutter.ActorAlign.CENTER;
        for (const child of widget)
            child.x_align = Clutter.ActorAlign.CENTER;
    }

    // -- teardown ------------------------------------------------------------

    _teardown() {
        Main.layoutManager.disconnectObject(this);
        const dialog = this._dialog;
        if (dialog) {
            dialog._authPrompt?.disconnectObject(this);
            dialog._userList?.disconnectObject(this);
            dialog._userList?._box.disconnectObject(this);
            dialog._notListedButton?.disconnectObject(this);
            dialog._rsxLogin = false;
            dialog.remove_style_class_name('rsx-login');
            dialog._logoBin.opacity = 255;
            dialog.queue_relayout();
        }
        Main.panel.statusArea.dateMenu?.container.show();
        Main.screenShield?._lockDialogGroup?.disconnectObject(this);
        this._smoke?.destroy();
        this._smoke = null;
        this._clockBin?.destroy();
        this._bgGroup?.destroy();
        this._clockBin = this._clock = this._bgGroup = this._dialog = null;
    }

    disable() {
        this._teardown();
        if (this._origCenterAlloc)
            LoginDialog.prototype._getCenterActorAllocation = this._origCenterAlloc;
        this._origCenterAlloc = null;
    }
}

// One feature, two halves depending on where the shell runs.
export class CupertinoLogin {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        if (Main.sessionMode.isGreeter)
            this._impl = new GreeterLook(this._settings);
        else if (!Main.sessionMode.isLocked)
            this._impl = new WallpaperExport(this._settings);
        this._impl?.enable();
    }

    disable() {
        this._impl?.disable();
        this._impl = null;
    }
}
