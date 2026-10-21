// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shake to find the cursor, like on macOS: shake the mouse quickly and the
// pointer grows big for a moment.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PointerWatcher from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

const POLL_MS = 16;
const WINDOW_US = 600 * 1000; // look at the last 0.6 s of movement
const MIN_REVERSALS = 4; // left-right-left-right…
const MIN_SWING = 40; // px a swing must cover to count
const MIN_SPEED = 1.5; // px per ms on average
const BIG_SCALE = 4;
const GROW_TIME = 220;
const SHRINK_TIME = 300;
const HOLD_MS = 700; // stay big this long after the shaking stops
const ARROW_SIZE = 28; // normal-size arrow, in logical px

// A crisp macOS-style arrow (black with a white outline), drawn at full size
// and scaled down, so it stays sharp while growing.
function makeArrow(size) {
    const area = new St.DrawingArea({width: size, height: size, reactive: false});
    area.connect('repaint', () => {
        const cr = area.get_context();
        const k = size / 32;
        cr.scale(k, k);
        cr.moveTo(3, 2);
        cr.lineTo(3, 26);
        cr.lineTo(9, 20.5);
        cr.lineTo(13, 29.5);
        cr.lineTo(17, 27.8);
        cr.lineTo(13, 19);
        cr.lineTo(21, 19);
        cr.closePath();
        cr.setLineJoin(1); // ROUND
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.setLineWidth(2.4);
        cr.strokePreserve();
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.fill();
        cr.$dispose();
    });
    return area;
}

export class ShakeCursor {
    enable() {
        this._tracker = global.backend.get_cursor_tracker();
        this._samples = [];
        this._big = false;
        this._watch = PointerWatcher.getPointerWatcher().addWatch(POLL_MS,
            (x, y) => this._onMove(x, y));
    }

    _onMove(x, y) {
        const now = GLib.get_monotonic_time();
        this._samples.push({t: now, x, y});
        while (this._samples.length && now - this._samples[0].t > WINDOW_US)
            this._samples.shift();

        if (this._big)
            this._follow(x, y);

        if (this._isShaking()) {
            this._samples = [];
            this._grow(x, y);
        }
    }

    // Several fast back-and-forth swings, horizontally or vertically.
    _isShaking() {
        const s = this._samples;
        if (s.length < 6)
            return false;
        const elapsedMs = (s[s.length - 1].t - s[0].t) / 1000;
        if (elapsedMs <= 0)
            return false;

        for (const axis of ['x', 'y']) {
            let reversals = 0;
            let dir = 0;
            let swing = 0;
            let path = 0;
            for (let i = 1; i < s.length; i++) {
                const d = s[i][axis] - s[i - 1][axis];
                path += Math.abs(d);
                if (d === 0)
                    continue;
                const sign = Math.sign(d);
                if (sign === dir) {
                    swing += Math.abs(d);
                } else {
                    if (dir !== 0 && swing >= MIN_SWING)
                        reversals++;
                    dir = sign;
                    swing = Math.abs(d);
                }
            }
            if (reversals >= MIN_REVERSALS && path / elapsedMs >= MIN_SPEED)
                return true;
        }
        return false;
    }

    _ensureActor() {
        if (this._actor)
            return;
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const full = ARROW_SIZE * scaleFactor * BIG_SCALE;
        this._actor = makeArrow(full);
        // Tip of the arrow (3,2 in the 32-unit drawing) sits on the pointer.
        this._actor.set_pivot_point(3 / 32, 2 / 32);
        this._actor.set_translation(-full * 3 / 32, -full * 2 / 32, 0);
        this._actor.visible = false;
        Main.uiGroup.add_child(this._actor);
    }

    _follow(x, y) {
        this._actor?.set_position(x, y);
    }

    _grow(x, y) {
        this._ensureActor();
        if (!this._big) {
            this._big = true;
            this._tracker.inhibit_cursor_visibility();
            global.compositor.disable_unredirect();
            this._actor.get_parent().set_child_above_sibling(this._actor, null);
            const small = 1 / BIG_SCALE;
            this._actor.set({scale_x: small, scale_y: small, visible: true});
            this._follow(x, y);
        }
        this._actor.ease({
            scale_x: 1,
            scale_y: 1,
            duration: GROW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        if (this._holdId)
            GLib.source_remove(this._holdId);
        this._holdId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_MS, () => {
            this._holdId = 0;
            this._shrink();
            return GLib.SOURCE_REMOVE;
        });
    }

    _shrink() {
        this._actor?.ease({
            scale_x: 1 / BIG_SCALE,
            scale_y: 1 / BIG_SCALE,
            duration: SHRINK_TIME,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onStopped: () => this._restore(),
        });
    }

    _restore() {
        if (!this._big)
            return;
        this._big = false;
        if (this._actor)
            this._actor.visible = false;
        this._tracker.uninhibit_cursor_visibility();
        global.compositor.enable_unredirect();
    }

    disable() {
        this._watch?.remove();
        this._watch = null;
        if (this._holdId)
            GLib.source_remove(this._holdId);
        this._holdId = 0;
        this._actor?.remove_all_transitions();
        this._restore();
        this._actor?.destroy();
        this._actor = null;
        this._samples = [];
    }
}

