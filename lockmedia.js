// SPDX-License-Identifier: GPL-3.0-or-later
//
// Now playing on the lock screen, like on iPhone: a big cover in the middle
// of the screen with the title, artist and previous / play / next buttons.

import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import {MprisSource} from 'resource:///org/gnome/shell/ui/mpris.js';
import {activePlayer, artistsText, coverActor} from './media.js';

const COVER_SIZE = 220;

function button(iconName, onClick) {
    const b = new St.Button({
        style_class: 'rsx-lock-media-button',
        can_focus: true,
        child: new St.Icon({icon_name: iconName}),
    });
    b.connect('clicked', onClick);
    return b;
}

class LockPlayer {
    constructor(dialog) {
        this._dialog = dialog;
        this._mpris = new MprisSource();
        this._player = null;
        this._coverUrl = null;

        this._bin = new St.Bin({x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL});
        this._bin.add_constraint(new Layout.MonitorConstraint({primary: true}));
        this._box = new St.BoxLayout({
            style_class: 'rsx-lock-media',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._bin.set_child(this._box);

        this._coverBin = new St.Bin({x_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._coverBin);

        this._title = new St.Label({style_class: 'rsx-lock-media-title', x_align: Clutter.ActorAlign.CENTER});
        this._artist = new St.Label({style_class: 'rsx-lock-media-artist', x_align: Clutter.ActorAlign.CENTER});
        for (const l of [this._title, this._artist])
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._box.add_child(this._title);
        this._box.add_child(this._artist);

        const controls = new St.BoxLayout({style_class: 'rsx-lock-media-controls', x_align: Clutter.ActorAlign.CENTER});
        this._prev = button('media-skip-backward-symbolic', () => this._player?.previous());
        this._play = button('media-playback-start-symbolic', () => this._player?.playPause());
        this._next = button('media-skip-forward-symbolic', () => this._player?.next());
        this._play.add_style_class_name('rsx-lock-media-play');
        controls.add_child(this._prev);
        controls.add_child(this._play);
        controls.add_child(this._next);
        this._box.add_child(controls);

        // Goes away together with the lock screen.
        this._bin.connect('destroy', () => {
            this._disconnect();
            this._bin = null;
        });
        dialog.add_child(this._bin);
        dialog.set_child_above_sibling(this._bin, null);

        this._mpris.connectObject(
            'player-added', (_s, p) => this._watch(p),
            'player-removed', (_s, p) => {
                p.disconnectObject(this);
                this._sync();
            }, this);
        this._mpris.players.forEach(p => this._watch(p));
        this._sync();
    }

    _watch(player) {
        player.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const player = activePlayer(this._mpris);
        this._player = player;
        this._box.visible = !!player;
        if (!player)
            return;

        if (player.trackCoverUrl !== this._coverUrl || !this._coverBin.child) {
            this._coverUrl = player.trackCoverUrl;
            this._coverBin.set_child(coverActor(this._coverUrl, COVER_SIZE, 18, 'rsx-lock-media-cover'));
        }
        this._title.text = player.trackTitle ?? '';
        this._artist.text = artistsText(player);
        this._play.child.icon_name = player.status === 'Playing'
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._prev.reactive = player.canGoPrevious;
        this._next.reactive = player.canGoNext;
        this._prev.opacity = player.canGoPrevious ? 255 : 100;
        this._next.opacity = player.canGoNext ? 255 : 100;
    }

    _disconnect() {
        this._mpris.disconnectObject(this);
        for (const p of this._mpris.players)
            p.disconnectObject(this);
    }

    destroy() {
        this._bin?.destroy();
    }
}

export class LockMedia {
    enable() {
        Main.sessionMode.connectObject('updated', () => this._sync(), this);
        Main.screenShield?.connectObject('lock-screen-shown', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const dialog = Main.screenShield?._dialog;
        if (!Main.sessionMode.isLocked || !dialog) {
            this._detach();
            return;
        }
        if (this._dialog === dialog)
            return;
        this._detach();
        this._dialog = dialog;
        this._player = new LockPlayer(dialog);
        dialog.connectObject('destroy', () => {
            this._player = null;
            this._dialog = null;
        }, this);
    }

    _detach() {
        this._dialog?.disconnectObject(this);
        this._player?.destroy();
        this._player = null;
        this._dialog = null;
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        Main.screenShield?.disconnectObject(this);
        this._detach();
    }
}
