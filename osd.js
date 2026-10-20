// SPDX-License-Identifier: GPL-3.0-or-later
//
// Volume / brightness popup like on macOS: a rounded square above the dock
// with a big icon and a bar of 16 segments.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {OsdWindow} from 'resource:///org/gnome/shell/ui/osdWindow.js';

const SEGMENTS = 16;

function decorate(osd) {
    if (osd._rsxBar)
        return;
    const hbox = osd._hbox;
    hbox.orientation = Clutter.Orientation.VERTICAL;
    hbox.add_style_class_name('rsx-hud');
    osd._icon.x_align = Clutter.ActorAlign.CENTER;
    osd._vbox.x_align = Clutter.ActorAlign.CENTER;

    const bar = new St.BoxLayout({style_class: 'rsx-hud-bar', x_align: Clutter.ActorAlign.CENTER});
    for (let i = 0; i < SEGMENTS; i++)
        bar.add_child(new St.Widget({style_class: 'rsx-hud-seg'}));
    osd._vbox.add_child(bar);
    osd._rsxBar = bar;
    syncBar(osd);
}

function undecorate(osd) {
    if (!osd._rsxBar)
        return;
    osd._rsxBar.destroy();
    delete osd._rsxBar;
    osd._hbox.orientation = Clutter.Orientation.HORIZONTAL;
    osd._hbox.remove_style_class_name('rsx-hud');
    osd._level.visible = osd._rsxLevel != null;
}

// Mirror GNOME's level bar in the segments and hide the original bar.
function syncBar(osd) {
    const bar = osd._rsxBar;
    if (!bar)
        return;
    const value = osd._rsxLevel;
    bar.visible = value != null;
    osd._level.visible = false;
    if (value != null) {
        const max = osd._level.maximum_value > 0 ? osd._level.maximum_value : 1;
        const lit = Math.round(Math.min(value / max, 1) * SEGMENTS);
        [...bar].forEach((seg, i) => {
            if (i < lit)
                seg.add_style_pseudo_class('checked');
            else
                seg.remove_style_pseudo_class('checked');
        });
    }
    osd._updateBoxVisibility();
}

export class MacOsd {
    enable() {
        const proto = OsdWindow.prototype;
        this._orig = {
            setLevel: proto.setLevel,
            setMaxLevel: proto.setMaxLevel,
            show: proto.show,
        };
        const orig = this._orig;
        proto.setLevel = function (value) {
            this._rsxLevel = value;
            orig.setLevel.call(this, value);
            syncBar(this);
        };
        proto.setMaxLevel = function (maxLevel) {
            orig.setMaxLevel.call(this, maxLevel);
            syncBar(this);
        };
        proto.show = function () {
            decorate(this);
            orig.show.call(this);
        };
    }

    disable() {
        if (this._orig)
            Object.assign(OsdWindow.prototype, this._orig);
        this._orig = null;
        for (const osd of Main.osdWindowManager?._osdWindows ?? []) {
            if (osd)
                undecorate(osd);
        }
    }
}
