// SPDX-License-Identifier: GPL-3.0-or-later
//
// Clipboard history in the macOS / Windows style: copied text and images
// are kept in a history; Super+V opens a card with search, and picking an
// item puts it back on the clipboard and pastes it into the focused window.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {_, _f} from './i18n.js';

const CACHE_DIR = `${GLib.get_user_cache_dir()}/rsx/clipboard`;
const HISTORY_FILE = `${CACHE_DIR}/history.json`;
const MAX_TEXT = 100000; // characters kept per text item
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];
const TEXT_TYPES = ['text/plain;charset=utf-8', 'UTF8_STRING', 'text/plain', 'STRING'];
// Password managers mark secrets with this; never store those.
const SECRET_HINT = 'x-kde-passwordManagerHint';
const TERMINALS = ['terminal', 'ptyxis', 'kgx', 'console', 'kitty', 'alacritty',
    'wezterm', 'foot', 'tilix', 'konsole', 'xterm', 'terminator', 'ghostty'];

const CLIPBOARD = St.ClipboardType.CLIPBOARD;

function timeAgo(usec) {
    const sec = Math.max(0, (GLib.get_real_time() - usec) / 1e6);
    if (sec < 60)
        return _('now');
    if (sec < 3600)
        return _f('%d min', Math.floor(sec / 60));
    if (sec < 86400)
        return _f('%d h', Math.floor(sec / 3600));
    return _f('%d d', Math.floor(sec / 86400));
}

function formatSize(bytes) {
    if (bytes < 1024)
        return _f('%d B', bytes);
    if (bytes < 1024 * 1024)
        return _f('%d KB', Math.round(bytes / 1024));
    return _f('%s MB', (bytes / 1024 / 1024).toFixed(1));
}

// ---------------------------------------------------------------------------
// History: records the clipboard and stores it on disk
// ---------------------------------------------------------------------------

class History {
    constructor(settings) {
        this._settings = settings;
        this._clipboard = St.Clipboard.get_default();
        this.items = [];
        this._load();
    }

    get _max() {
        return this._settings.get_int('clipboard-max-items');
    }

    start() {
        global.display.get_selection().connectObject('owner-changed',
            (_sel, type) => {
                if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                    this._read();
            }, this);
    }

    stop() {
        global.display.get_selection().disconnectObject(this);
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveNow();
        }
    }

    _read() {
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
            return;

        const mimes = this._clipboard.get_mimetypes(CLIPBOARD) ?? [];
        if (mimes.includes(SECRET_HINT))
            return;

        const image = IMAGE_TYPES.find(t => mimes.includes(t));
        const hasText = TEXT_TYPES.some(t => mimes.includes(t));
        if (image && !hasText) {
            this._clipboard.get_content(CLIPBOARD, image, (_c, bytes) => {
                if (bytes?.get_size())
                    this._addImage(image, bytes);
            });
        } else if (hasText || mimes.length === 0) {
            this._clipboard.get_text(CLIPBOARD, (_c, text) => {
                if (text && text.trim())
                    this._addText(text.slice(0, MAX_TEXT));
            });
        }
    }

    _addText(text) {
        const existing = this.items.find(i => i.type === 'text' && i.text === text);
        if (existing) {
            this._toTop(existing);
            return;
        }
        this._add({type: 'text', text});
    }

    _addImage(mime, bytes) {
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        const existing = this.items.find(i => i.type === 'image' && i.hash === hash);
        if (existing) {
            this._toTop(existing);
            return;
        }
        const ext = mime.split('/')[1];
        const file = `${CACHE_DIR}/${hash}.${ext}`;
        try {
            this._ensureDir();
            Gio.File.new_for_path(file).replace_contents(bytes.toArray(), null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`rsx@rsx: couldn't store clipboard image: ${e.message}`);
            return;
        }
        this._add({type: 'image', mime, hash, file, size: bytes.get_size()});
    }

    _add(item) {
        item.id = `${GLib.get_real_time()}-${Math.random().toString(36).slice(2, 8)}`;
        item.time = GLib.get_real_time();
        this.items.unshift(item);
        while (this.items.length > this._max)
            this._deleteFiles(this.items.pop());
        this._save();
    }

    _toTop(item) {
        this.items.splice(this.items.indexOf(item), 1);
        item.time = GLib.get_real_time();
        this.items.unshift(item);
        this._save();
    }

    remove(item) {
        const i = this.items.indexOf(item);
        if (i < 0)
            return;
        this.items.splice(i, 1);
        this._deleteFiles(item);
        this._save();
    }

    clear() {
        this.items.forEach(i => this._deleteFiles(i));
        this.items = [];
        this._save();
    }

    trim() {
        while (this.items.length > this._max)
            this._deleteFiles(this.items.pop());
        this._save();
    }

    // Put an item back on the clipboard (recording it moves it to the top).
    copy(item) {
        if (item.type === 'text') {
            this._clipboard.set_text(CLIPBOARD, item.text);
        } else {
            const [, contents] = GLib.file_get_contents(item.file);
            this._clipboard.set_content(CLIPBOARD, item.mime, new GLib.Bytes(contents));
        }
    }

    _deleteFiles(item) {
        if (item.type === 'image' && !this.items.some(i => i.hash === item.hash)) {
            try {
                Gio.File.new_for_path(item.file).delete(null);
            } catch {
                // Already gone.
            }
        }
    }

    _ensureDir() {
        GLib.mkdir_with_parents(CACHE_DIR, 0o700);
    }

    _load() {
        try {
            const [, bytes] = GLib.file_get_contents(HISTORY_FILE);
            const items = JSON.parse(new TextDecoder().decode(bytes));
            this.items = items.filter(i => i.type === 'text' ||
                (i.type === 'image' && GLib.file_test(i.file, GLib.FileTest.EXISTS)));
        } catch {
            this.items = [];
        }
    }

    // Saving is debounced so a burst of copies writes once.
    _save() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_LOW, 500, () => {
            this._saveId = 0;
            this._saveNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveNow() {
        try {
            this._ensureDir();
            const json = new TextEncoder().encode(JSON.stringify(this.items));
            Gio.File.new_for_path(HISTORY_FILE).replace_contents(json, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`rsx@rsx: couldn't save clipboard history: ${e.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Popup: the Super+V card
// ---------------------------------------------------------------------------

class Popup {
    constructor(history, onPick) {
        this._history = history;
        this._onPick = onPick;
        this._selected = 0;
        this._rows = [];

        // Full-screen catcher: click outside the card closes it.
        // Fixed layout: we place the card ourselves, so its top edge stays
        // put while the list shrinks or grows during search.
        this.actor = new St.Widget({reactive: true});
        this.actor.add_constraint(new Layout.MonitorConstraint({primary: true}));
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => this.close());
        this.actor.add_action(click);

        this._card = new St.BoxLayout({
            style_class: 'rsx-clip-card',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._card.set_pivot_point(0.5, 0);
        this._card.connect('notify::width', () => this._placeCard());
        this.actor.add_child(this._card);

        this._entry = new St.Entry({
            style_class: 'rsx-clip-search',
            hint_text: _('Search the clipboard'),
            can_focus: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'rsx-clip-search-icon'}),
        });
        this._entry.clutter_text.connect('text-changed', () => {
            this._selected = 0;
            this._rebuild();
        });
        this._entry.clutter_text.connect('key-press-event', (_a, event) => this._onKey(event));
        this._card.add_child(this._entry);

        this._list = new St.BoxLayout({
            style_class: 'rsx-clip-list',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._scroll = new St.ScrollView({
            style_class: 'rsx-clip-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._list,
            y_expand: true,
        });
        this._card.add_child(this._scroll);

        this._footer = new St.Label({
            style_class: 'rsx-clip-footer',
            text: _('↑↓ select   ↵ paste   Del remove   Esc close'),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._card.add_child(this._footer);
    }

    open() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._card.set_style(`max-height: ${Math.round(monitor.height * 0.6)}px;`);
        Main.layoutManager.uiGroup.add_child(this.actor);
        this._placeCard();
        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});

        this._rebuild();
        this._entry.grab_key_focus();

        this._card.set({opacity: 0, scale_x: 0.97, scale_y: 0.97, translation_y: -8});
        this._card.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            translation_y: 0,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return true;
    }

    // Centered horizontally, top edge at a fixed height (like Spotlight).
    _placeCard() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._card.set_position(
            Math.round((monitor.width - this._card.width) / 2),
            Math.round(monitor.height * 0.18));
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this.actor.destroy();
        this.onClosed?.();
    }

    _filtered() {
        const q = this._entry.get_text().trim().toLowerCase();
        if (!q)
            return this._history.items;
        return this._history.items.filter(i =>
            i.type === 'text' ? i.text.toLowerCase().includes(q) : `${_('Image')} image`.toLowerCase().includes(q));
    }

    _rebuild() {
        this._list.destroy_all_children();
        this._items = this._filtered();
        this._rows = [];

        if (this._items.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'rsx-clip-empty',
                text: this._history.items.length ? _('Nothing found') : _('History is empty. Copy something'),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            return;
        }

        this._selected = Math.min(this._selected, this._items.length - 1);
        this._items.forEach((item, index) => {
            const row = this._makeRow(item, index);
            this._rows.push(row);
            this._list.add_child(row);
        });
        this._syncSelection(false);
    }

    _makeRow(item, index) {
        const row = new St.Button({
            style_class: 'rsx-clip-item',
            can_focus: false,
            x_expand: true,
        });
        const box = new St.BoxLayout({x_expand: true, style_class: 'rsx-clip-item-box'});
        row.set_child(box);

        if (item.type === 'image') {
            const thumb = new St.Widget({
                style_class: 'rsx-clip-thumb',
                style: `background-image: url("${Gio.File.new_for_path(item.file).get_uri()}");`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(thumb);
            box.add_child(new St.Label({
                style_class: 'rsx-clip-text',
                text: `${_('Image')} · ${formatSize(item.size ?? 0)}`,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        } else {
            const label = new St.Label({
                style_class: 'rsx-clip-text',
                text: item.text.replace(/\s+/g, ' ').trim().slice(0, 300),
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(label);
        }

        box.add_child(new St.Label({
            style_class: 'rsx-clip-time',
            text: timeAgo(item.time),
            y_align: Clutter.ActorAlign.CENTER,
        }));

        row.connect('clicked', () => this._pick(item));
        row.connect('notify::hover', () => {
            if (row.hover) {
                this._selected = index;
                this._syncSelection(false);
            }
        });
        return row;
    }

    _syncSelection(scroll = true) {
        this._rows.forEach((row, i) => {
            if (i === this._selected)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
        const row = this._rows[this._selected];
        if (row && scroll)
            ensureActorVisibleInScrollView(this._scroll, row);
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        const count = this._rows.length;
        switch (key) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
            if (count)
                this._selected = (this._selected + 1) % count;
            this._syncSelection();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            if (count)
                this._selected = (this._selected - 1 + count) % count;
            this._syncSelection();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (count)
                this._pick(this._items[this._selected]);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete:
            // In the search field Delete edits text; with an empty search
            // it removes the selected item.
            if (count && this._entry.get_text() === '') {
                this._history.remove(this._items[this._selected]);
                this._rebuild();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _pick(item) {
        this.close();
        this._onPick(item);
    }
}

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

export class ClipboardHistory {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        this._history = new History(this._settings);
        this._history.start();

        Main.wm.addKeybinding('clipboard-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggle());

        this._settings.connectObject(
            'changed::clipboard-max-items', () => this._history.trim(),
            'changed::clipboard-clear-request', () => {
                this._popup?.close();
                this._history.clear();
            },
            this);
    }

    _toggle() {
        if (this._popup) {
            this._popup.close();
            return;
        }
        this._popup = new Popup(this._history, item => this._paste(item));
        this._popup.onClosed = () => (this._popup = null);
        if (!this._popup.open())
            this._popup = null;
    }

    _paste(item) {
        try {
            this._history.copy(item);
        } catch (e) {
            console.warn(`rsx@rsx: couldn't copy clipboard item: ${e.message}`);
            return;
        }
        if (!this._settings.get_boolean('clipboard-paste-on-select'))
            return;

        // Give focus a moment to return to the window, then press Ctrl+V
        // (Ctrl+Shift+V in terminals).
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            this._pasteId = 0;
            this._sendPasteKeys();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPasteKeys() {
        const wmClass = (global.display.focus_window?.get_wm_class() ?? '').toLowerCase();
        const terminal = TERMINALS.some(t => wmClass.includes(t));

        if (!this._keyboard) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        const keys = terminal
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        const time = GLib.get_monotonic_time();
        keys.forEach(k => this._keyboard.notify_keyval(time, k, Clutter.KeyState.PRESSED));
        keys.reverse().forEach(k => this._keyboard.notify_keyval(time, k, Clutter.KeyState.RELEASED));
    }

    disable() {
        Main.wm.removeKeybinding('clipboard-shortcut');
        this._settings.disconnectObject(this);
        if (this._pasteId) {
            GLib.source_remove(this._pasteId);
            this._pasteId = 0;
        }
        this._popup?.close();
        this._popup = null;
        this._history.stop();
        this._history = null;
        this._keyboard?.run_dispose();
        this._keyboard = null;
    }
}
