// SPDX-License-Identifier: GPL-3.0-or-later
//
// New windows: open centered on the screen with the mouse, and open/close
// with a soft, modern motion instead of GNOME's quick zoom.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {curveTransition} from './motion.js';

// -- Centered new windows -----------------------------------------------------

export class CenterWindows {
    enable() {
        global.window_manager.connectObject('map', (_wm, actor) => this._center(actor), this);
    }

    _center(actor) {
        const win = actor.meta_window;
        if (!win || win.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        if (win.get_transient_for() || win.is_fullscreen() || win.is_maximized?.() ||
            win.get_maximized?.())
            return;

        const monitor = global.display.get_current_monitor();
        const area = win.get_work_area_for_monitor(monitor);
        const frame = win.get_frame_rect();
        if (frame.width > area.width || frame.height > area.height)
            return;

        const x = area.x + Math.round((area.width - frame.width) / 2);
        const y = area.y + Math.round((area.height - frame.height) / 2);
        if (x !== frame.x || y !== frame.y)
            win.move_frame(true, x, y);
    }

    disable() {
        global.window_manager.disconnectObject(this);
    }
}

// -- Smooth open/close --------------------------------------------------------
//
// Opening: the window fades in while it grows a little and rises into place,
// on a quick-start, soft-landing curve. Closing: a short fade and shrink.

const OPEN_TIME = 420;
const OPEN_FADE_TIME = 200;
const OPEN_SCALE = 0.93;
const OPEN_RISE = 18; // px the window rises while opening
const CLOSE_TIME = 180;
const CLOSE_SCALE = 0.95;

// Which of GNOME's window animations this ease() call is, if any.
function windowAnimation(actor, params) {
    if (!(actor instanceof Meta.WindowActor))
        return null;
    if (actor.meta_window?.get_window_type() !== Meta.WindowType.NORMAL)
        return null;
    if (Main.wm._mapping?.has(actor) && params.opacity === 255)
        return 'open';
    if (Main.wm._destroying?.has(actor) && params.opacity === 0)
        return 'close';
    return null;
}

export class SmoothWindows {
    enable() {
        const proto = Clutter.Actor.prototype;
        const origEase = proto.ease;
        this._origEase = origEase;

        proto.ease = function (params) {
            switch (windowAnimation(this, params)) {
            case 'open': {
                const {onStopped, onComplete} = params;
                // Respect "reduce animations" (duration 0 then).
                this.save_easing_state();
                this.set_easing_duration(OPEN_TIME);
                const duration = this.get_easing_duration();
                this.restore_easing_state();
                if (duration <= 0) {
                    this.set({scale_x: 1, scale_y: 1, translation_y: 0, opacity: 255});
                    onComplete?.();
                    onStopped?.(true);
                    return;
                }

                const rise = OPEN_RISE * St.ThemeContext.get_for_stage(global.stage).scaleFactor;
                this.set_pivot_point(0.5, 0.5);
                this.set({scale_x: OPEN_SCALE, scale_y: OPEN_SCALE, translation_y: rise, opacity: 0});
                origEase.call(this, {
                    opacity: 255,
                    duration: OPEN_FADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                const tx = curveTransition('scale-x', OPEN_SCALE, 1, duration);
                const ty = curveTransition('scale-y', OPEN_SCALE, 1, duration);
                const tr = curveTransition('translation-y', rise, 0, duration);
                let done = false;
                tx.connect('stopped', (_t, finished) => {
                    if (done)
                        return;
                    done = true;
                    this.remove_transition('rsx-open-y');
                    this.remove_transition('rsx-open-rise');
                    this.set({scale_x: 1, scale_y: 1, translation_y: 0});
                    if (finished)
                        onComplete?.();
                    onStopped?.(finished);
                });
                this.add_transition('rsx-open-y', ty);
                this.add_transition('rsx-open-rise', tr);
                this.add_transition('rsx-open-x', tx);
                return;
            }
            case 'close':
                origEase.call(this, {
                    ...params,
                    scale_x: CLOSE_SCALE,
                    scale_y: CLOSE_SCALE,
                    duration: CLOSE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                return;
            default:
                origEase.call(this, params);
            }
        };
    }

    disable() {
        if (this._origEase)
            Clutter.Actor.prototype.ease = this._origEase;
        this._origEase = null;
    }
}
