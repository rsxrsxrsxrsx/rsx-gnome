// SPDX-License-Identifier: GPL-3.0-or-later
//
// More things for the dynamic island to tell about: upcoming calendar
// events, Bluetooth headphones (with their battery), text copied to the
// clipboard; and two modes kept here: Do Not Disturb and "stay awake".
//
// Each watcher gets the island's push function and returns a stop function.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {_} from './i18n.js';

const MINUTE = 60 * 1000;
const EVENT_SOON = 10 * MINUTE; // "in 10 minutes"
const EVENT_CHECK_S = 20;
const EVENT_MS = 8000;
const BT_MS = 3500;
const CLIP_MS = 1600;
const CLIP_CHARS = 48;
const SECRET_HINT = 'x-kde-passwordManagerHint';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
const TEXT_TYPES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];

function minutesText(ms) {
    const m = Math.max(1, Math.round(ms / MINUTE));
    return _('in %d min').replace('%d', m);
}

function timeText(date) {
    const d = GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000));
    return d.format('%H:%M');
}

// -- calendar -----------------------------------------------------------------

// GNOME's own calendar (the one in the clock menu) already has the events;
// we only look at them. Each event is announced twice: ten minutes before,
// and when it starts.
export function watchCalendar(push) {
    const told = new Map(); // id → 'soon' | 'now'
    const check = () => {
        const source = Main.panel.statusArea.dateMenu?._eventSource;
        if (!source || source.isLoading || !source.hasCalendars)
            return;
        const t = Date.now();
        const events = source.getEvents(new Date(t - MINUTE), new Date(t + EVENT_SOON + MINUTE));
        for (const event of events) {
            const start = event.date.getTime();
            const allDay = event.end.getTime() - start >= 24 * 60 * MINUTE - 1000;
            if (allDay || !event.summary)
                continue;
            const left = start - t;
            const key = `${event.id}@${start}`;
            const state = told.get(key);
            if (left <= 0 && left > -2 * MINUTE && state !== 'now') {
                told.set(key, 'now');
                push({
                    kind: 'calendar',
                    icon: 'x-office-calendar-symbolic',
                    accent: true,
                    title: event.summary,
                    subtitle: _('Starting now · until %s').replace('%s', timeText(event.end)),
                    timeout: EVENT_MS,
                    onClick: () => Main.panel.statusArea.dateMenu?.menu.open(),
                });
            } else if (left > 0 && left <= EVENT_SOON && !state) {
                told.set(key, 'soon');
                push({
                    kind: 'calendar',
                    icon: 'x-office-calendar-symbolic',
                    title: event.summary,
                    subtitle: `${minutesText(left)} · ${timeText(event.date)}`,
                    timeout: EVENT_MS,
                    onClick: () => Main.panel.statusArea.dateMenu?.menu.open(),
                });
            }
        }
        // Forget events long gone.
        for (const key of told.keys()) {
            const start = Number(key.split('@').pop());
            if (t - start > 60 * MINUTE)
                told.delete(key);
        }
    };
    const id = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, EVENT_CHECK_S, () => {
        check();
        return GLib.SOURCE_CONTINUE;
    });
    // Don't announce what's already on at login as "starting now".
    GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 5, () => {
        const source = Main.panel.statusArea.dateMenu?._eventSource;
        const t = Date.now();
        for (const e of source?.getEvents?.(new Date(t - 2 * MINUTE), new Date(t)) ?? [])
            told.set(`${e.id}@${e.date.getTime()}`, 'now');
        return GLib.SOURCE_REMOVE;
    });
    return () => GLib.source_remove(id);
}

// -- Bluetooth ----------------------------------------------------------------

const BLUEZ = 'org.bluez';
const DEVICE = 'org.bluez.Device1';
const BATTERY = 'org.bluez.Battery1';

// Headphones, speakers, mice: "connected" with the battery if it reports one.
export function watchBluetooth(push) {
    let manager = null;
    let stopped = false;
    const connected = new Map(); // object path → bool

    const unpack = (proxy, name) => proxy?.get_cached_property(name)?.deepUnpack();

    const announce = (object, on) => {
        const device = object.get_interface(DEVICE);
        const name = unpack(device, 'Alias') ?? unpack(device, 'Name') ?? _('Bluetooth device');
        const icon = unpack(device, 'Icon') || 'bluetooth';
        const battery = unpack(object.get_interface(BATTERY), 'Percentage');
        const parts = [on ? _('Connected') : _('Disconnected')];
        if (on && Number.isFinite(battery))
            parts.push(`${battery}%`);
        push({
            // Same kind as the sound output change, which comes at the same
            // moment for headphones: one replaces the other.
            kind: 'output',
            icon: `${icon}-symbolic`,
            fallbackIcon: 'bluetooth-active-symbolic',
            accent: on,
            title: name,
            subtitle: parts.join(' · '),
            timeout: BT_MS,
        });
    };

    const watch = object => {
        const device = object.get_interface(DEVICE);
        if (!device)
            return;
        const path = object.get_object_path();
        connected.set(path, !!unpack(device, 'Connected'));
        device.connect('g-properties-changed', () => {
            const on = !!unpack(device, 'Connected');
            if (on === connected.get(path))
                return;
            connected.set(path, on);
            // The battery level comes a moment after connecting.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, on ? 1500 : 0, () => {
                if (!stopped)
                    announce(object, on);
                return GLib.SOURCE_REMOVE;
            });
        });
    };

    Gio.DBusObjectManagerClient.new_for_bus(Gio.BusType.SYSTEM,
        Gio.DBusObjectManagerClientFlags.NONE, BLUEZ, '/', null, null, (_o, res) => {
            try {
                manager = Gio.DBusObjectManagerClient.new_for_bus_finish(res);
            } catch {
                return; // no Bluetooth
            }
            if (stopped) {
                manager = null;
                return;
            }
            manager.get_objects().forEach(watch);
            manager.connect('object-added', (_m, object) => watch(object));
        });

    return () => {
        stopped = true;
        manager = null;
    };
}

// -- clipboard ----------------------------------------------------------------

// A short "Copied" with the start of the text.
export function watchClipboard(push, settings) {
    const selection = global.display.get_selection();
    const clipboard = St.Clipboard.get_default();
    const startedAt = GLib.get_monotonic_time();
    const id = selection.connect('owner-changed', (_s, type) => {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !settings.get_boolean('island-clipboard'))
            return;
        if (Main.sessionMode.isLocked || GLib.get_monotonic_time() - startedAt < 3e6)
            return;
        // Pasting from rsx's clipboard history sets the clipboard too.
        if (globalThis.rsxClipboardBusy)
            return;
        const mimes = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
        const show = subtitle => push({
            kind: 'clipboard',
            icon: 'edit-copy-symbolic',
            title: _('Copied'),
            subtitle,
            timeout: CLIP_MS,
        });
        if (mimes.includes(SECRET_HINT)) {
            show(_('Password'));
        } else if (IMAGE_TYPES.some(t => mimes.includes(t)) && !TEXT_TYPES.some(t => mimes.includes(t))) {
            show(_('Image'));
        } else {
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
                const line = (text ?? '').trim().replace(/\s+/g, ' ');
                if (!line)
                    return;
                show(line.length > CLIP_CHARS ? `${line.slice(0, CLIP_CHARS)}…` : line);
            });
        }
    });
    return () => selection.disconnect(id);
}

// -- modes --------------------------------------------------------------------

// Do Not Disturb is GNOME's own (no banners); "stay awake" holds an inhibitor
// on the session, so the screen doesn't blank and the computer doesn't
// sleep. It lasts until it's turned off or the session ends.
export class Modes {
    constructor(onChange) {
        this._onChange = onChange;
        this._notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._notifications.connectObject('changed::show-banners', () => this._onChange(), this);
        this._cookie = null;
        this._pending = false;
    }

    get dnd() {
        return !this._notifications.get_boolean('show-banners');
    }

    set dnd(on) {
        this._notifications.set_boolean('show-banners', !on);
    }

    get awake() {
        return this._cookie !== null || this._pending;
    }

    set awake(on) {
        if (on === this.awake)
            return;
        const call = (method, params, done) => Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
            method, params, null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                let result = null;
                try {
                    result = conn.call_finish(res);
                } catch (e) {
                    console.warn(`rsx@rsx: ${method}: ${e.message}`);
                }
                done?.(result);
            });
        if (on) {
            this._pending = true;
            // 4 suspend + 8 idle
            call('Inhibit', new GLib.Variant('(susu)', ['rsx', 0, _('Stay awake'), 12]), result => {
                this._pending = false;
                const cookie = result?.deepUnpack()[0] ?? null;
                if (this._destroyed && cookie !== null)
                    call('Uninhibit', new GLib.Variant('(u)', [cookie]));
                else
                    this._cookie = cookie;
                this._onChange();
            });
        } else {
            call('Uninhibit', new GLib.Variant('(u)', [this._cookie]));
            this._cookie = null;
        }
        this._onChange();
    }

    destroy() {
        this._destroyed = true;
        this._notifications.disconnectObject(this);
        if (this._cookie !== null)
            this.awake = false;
    }
}
