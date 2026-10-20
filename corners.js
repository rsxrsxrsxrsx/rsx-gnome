// SPDX-License-Identifier: GPL-3.0-or-later
//
// Rounded screen corners: a small black mask in every corner of every
// monitor, kept above everything else (windows, panel, lock screen).

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const RADIUS = 12;

// Corner positions: [x side, y side], 0 = left/top, 1 = right/bottom.
const CORNERS = [[0, 0], [1, 0], [0, 1], [1, 1]];

function makeCorner(size, [right, bottom]) {
    const area = new St.DrawingArea({width: size, height: size, reactive: false});
    area.connect('repaint', () => {
        const cr = area.get_context();
        // Black square minus a quarter circle centered on the inner corner.
        const cx = right ? 0 : size;
        const cy = bottom ? 0 : size;
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.rectangle(0, 0, size, size);
        cr.newSubPath();
        cr.arc(cx, cy, size, 0, Math.PI * 2);
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        cr.fill();
        cr.$dispose();
    });
    return area;
}

export class ScreenCorners {
    enable() {
        this._group = new Clutter.Actor({reactive: false});
        Main.layoutManager.uiGroup.add_child(this._group);
        Main.layoutManager.uiGroup.connectObject('child-added', () => this._raise(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._build(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._build(), this);
        this._build();
    }

    _build() {
        this._group.destroy_all_children();
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const size = RADIUS * scaleFactor;
        for (const monitor of Main.layoutManager.monitors) {
            for (const corner of CORNERS) {
                const area = makeCorner(size, corner);
                area.set_position(
                    monitor.x + (corner[0] ? monitor.width - size : 0),
                    monitor.y + (corner[1] ? monitor.height - size : 0));
                this._group.add_child(area);
            }
        }
        this._raise();
    }

    _raise() {
        const parent = this._group?.get_parent();
        if (parent && parent.get_last_child() !== this._group)
            parent.set_child_above_sibling(this._group, null);
    }

    disable() {
        Main.layoutManager.uiGroup.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._group?.destroy();
        this._group = null;
    }
}
