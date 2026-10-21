// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dynamic island: a black pill at the top center of the screen that pops out
// for a moment when the track changes, a notification arrives or the volume
// or brightness changes. It replaces GNOME's banners and volume popup while
// it's on (critical notifications still use the normal banner).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {MprisSource} from 'resource:///org/gnome/shell/ui/mpris.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';
import {activePlayer, artistsText, coverActor} from './media.js';

const SHOW_TIME = 380;
const HIDE_TIME = 260;
const MEDIA_MS = 3500;
const NOTIFICATION_MS = 4000;
const LEVEL_MS = 1500;
const TOP = 4; // px below the top of the screen

function label(text, styleClass) {
    const l = new St.Label({text: text ?? '', style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function textColumn(title, subtitle) {
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        style_class: 'rsx-island-text',
    });
    box.add_child(label(title, 'rsx-island-title'));
    if (subtitle)
        box.add_child(label(subtitle, 'rsx-island-subtitle'));
    return box;
}

export class DynamicIsland {
    enable() {
        this._queue = [];
        this._current = null;
        this._hideId = 0;

        this._island = new St.BoxLayout({
            style_class: 'rsx-island',
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this._island.set_pivot_point(0.5, 0);
        Main.layoutManager.uiGroup.add_child(this._island);
        this._island.connectObject(
            'notify::width', () => this._reposition(),
            'button-release-event', () => {
                this._current?.onClick?.();
                this._hide();
                return Clutter.EVENT_STOP;
            },
            'notify::hover', () => {
                // Keep it open while the mouse is over it.
                if (this._island.hover)
                    this._cancelHide();
                else if (this._current)
                    this._scheduleHide(1500);
            }, this);
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);

        this._watchMedia();
        this._watchNotifications();
        this._watchLevels();
    }

    // -- sources -------------------------------------------------------------

    _watchMedia() {
        this._mpris = new MprisSource();
        this._seen = new Map(); // player -> last "title|status" seen
        const track = player => {
            player.connectObject('changed', () => this._onPlayerChanged(player), this);
            this._seen.set(player, this._playerKey(player));
        };
        this._mpris.connectObject(
            'player-added', (_s, player) => track(player),
            'player-removed', (_s, player) => {
                player.disconnectObject(this);
                this._seen.delete(player);
            }, this);
    }

    _playerKey(player) {
        return `${player.trackTitle}|${player.status}`;
    }

    _onPlayerChanged(player) {
        const key = this._playerKey(player);
        const old = this._seen.get(player);
        this._seen.set(player, key);
        if (key === old || player.status !== 'Playing')
            return;
        if (activePlayer(this._mpris) !== player)
            return;
        this._push({
            kind: 'media',
            timeout: MEDIA_MS,
            build: () => {
                const box = new St.BoxLayout({style_class: 'rsx-island-row'});
                box.add_child(coverActor(player.trackCoverUrl, 34, 8, 'rsx-island-cover'));
                box.add_child(textColumn(player.trackTitle, artistsText(player)));
                box.add_child(new St.Icon({
                    icon_name: 'media-playback-start-symbolic',
                    style_class: 'rsx-island-badge',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                return box;
            },
            onClick: () => player.raise(),
        });
    }

    _watchNotifications() {
        const tray = Main.messageTray;
        this._tray = tray;
        const origShow = tray._showNotification;
        this._origShowNotification = origShow;
        const self = this;
        // GNOME is about to show a banner: show it in the island instead.
        tray._showNotification = function () {
            const notification = this._notificationQueue[0];
            if (!notification || notification.urgency === Urgency.CRITICAL)
                return origShow.call(this);
            this._notificationQueue.shift();
            this.emit('queue-changed');
            self._pushNotification(notification);
            // Let GNOME look at the rest of the queue after this call.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                tray._updateState();
                return GLib.SOURCE_REMOVE;
            });
            return undefined;
        };
    }

    _pushNotification(notification) {
        this._push({
            kind: 'notification',
            timeout: NOTIFICATION_MS,
            build: () => {
                const box = new St.BoxLayout({style_class: 'rsx-island-row'});
                const gicon = notification.gicon ?? notification.source?.icon ?? null;
                box.add_child(new St.Icon({
                    gicon,
                    icon_name: gicon ? null : 'preferences-system-notifications-symbolic',
                    icon_size: 30,
                    style_class: 'rsx-island-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                const body = (notification.body ?? '').split('\n')[0];
                box.add_child(textColumn(notification.title || notification.source?.title, body));
                return box;
            },
            onClick: () => notification.activate(),
        });
    }

    _watchLevels() {
        const osd = Main.osdWindowManager;
        this._osd = osd;
        const origShow = osd._showOsdWindow;
        this._origShowOsd = origShow;
        const self = this;
        osd._showOsdWindow = function (monitorIndex, icon, label, level, maxLevel) {
            if (level == null)
                return origShow.call(this, monitorIndex, icon, label, level, maxLevel);
            self._pushLevel(icon, level, maxLevel);
            return undefined;
        };
    }

    _pushLevel(icon, level, maxLevel) {
        const max = maxLevel > 0 ? maxLevel : 1;
        const fraction = Math.max(0, Math.min(level / max, 1));
        // Volume steps come fast: update in place instead of queueing.
        if (this._current?.kind === 'level' && this._levelFill) {
            this._levelIcon.gicon = icon;
            this._setFill(fraction);
            this._scheduleHide(LEVEL_MS);
            return;
        }
        this._push({
            kind: 'level',
            timeout: LEVEL_MS,
            urgent: true,
            build: () => {
                const box = new St.BoxLayout({style_class: 'rsx-island-row rsx-island-level'});
                this._levelIcon = new St.Icon({gicon: icon, icon_size: 18, y_align: Clutter.ActorAlign.CENTER});
                box.add_child(this._levelIcon);
                const track = new St.Widget({
                    style_class: 'rsx-island-track',
                    y_align: Clutter.ActorAlign.CENTER,
                    layout_manager: new Clutter.FixedLayout(),
                });
                this._levelFill = new St.Widget({style_class: 'rsx-island-fill'});
                track.add_child(this._levelFill);
                track.connect('notify::width', () => this._setFill(this._levelFraction));
                box.add_child(track);
                this._levelTrack = track;
                this._setFill(fraction);
                return box;
            },
        });
    }

    _setFill(fraction) {
        this._levelFraction = fraction;
        // Not on screen yet: the track sizes the fill once it's allocated.
        if (!this._levelFill || !this._levelTrack?.get_stage())
            return;
        const w = this._levelTrack.width;
        this._levelFill.set_size(Math.round(w * fraction), this._levelTrack.height);
    }

    // -- showing -------------------------------------------------------------

    _push(item) {
        if (item.urgent || !this._current) {
            this._show(item);
            return;
        }
        // One at a time; a new track replaces a queued older one.
        this._queue = this._queue.filter(q => q.kind !== item.kind || item.kind === 'notification');
        this._queue.push(item);
    }

    _show(item) {
        this._current = item;
        this._levelFill = this._levelTrack = this._levelIcon = null;
        const island = this._island;
        const wasVisible = island.visible;
        island.destroy_all_children();
        island.add_child(item.build());

        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        island.remove_all_transitions();
        island.get_parent().set_child_above_sibling(island, null);
        if (!wasVisible) {
            island.set({visible: true, opacity: 0, scale_x: 0.5, scale_y: 0.5});
            this._reposition();
            island.y = (Main.layoutManager.primaryMonitor?.y ?? 0) + TOP * scaleFactor;
        }
        island.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: SHOW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
        this._scheduleHide(item.timeout);
    }

    _scheduleHide(ms) {
        this._cancelHide();
        this._hideId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._hideId = 0;
            if (this._island.hover) {
                this._scheduleHide(1000);
                return GLib.SOURCE_REMOVE;
            }
            this._next();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelHide() {
        if (this._hideId)
            GLib.source_remove(this._hideId);
        this._hideId = 0;
    }

    _next() {
        const item = this._queue.shift();
        if (item)
            this._show(item);
        else
            this._hide();
    }

    _hide() {
        this._cancelHide();
        this._current = null;
        this._queue = [];
        this._island.ease({
            opacity: 0,
            scale_x: 0.6,
            scale_y: 0.6,
            duration: HIDE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: finished => {
                if (finished && !this._current) {
                    this._island.hide();
                    this._island.destroy_all_children();
                }
            },
        });
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._island)
            return;
        this._island.x = Math.round(monitor.x + (monitor.width - this._island.width) / 2);
    }

    disable() {
        this._cancelHide();
        // Remove the per-instance overrides: back to GNOME's own methods.
        if (this._tray)
            delete this._tray._showNotification;
        if (this._osd)
            delete this._osd._showOsdWindow;
        this._tray = this._osd = this._origShowNotification = this._origShowOsd = null;

        this._mpris?.disconnectObject(this);
        for (const player of this._seen?.keys() ?? [])
            player.disconnectObject(this);
        this._seen?.clear();
        this._mpris = null;

        Main.layoutManager.disconnectObject(this);
        this._island?.destroy();
        this._island = null;
        this._queue = [];
        this._current = null;
    }
}
