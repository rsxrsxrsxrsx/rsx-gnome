// SPDX-License-Identifier: GPL-3.0-or-later
//
// New windows: open centered on the screen with the mouse, and open/close
// with a soft spring instead of GNOME's quick zoom.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

// -- Spring open/close --------------------------------------------------------

const OPEN_TIME = 520;
const OPEN_FADE_TIME = 180;
const OPEN_SCALE = 0.86;
const CLOSE_TIME = 200;
const CLOSE_SCALE = 0.9;

// Damped spring from 0 to 1 (a little overshoot, then settles).
const DAMPING = 0.72;
const FREQUENCY = 2.6; // oscillations per second

function spring(seconds) {
    const w0 = 2 * Math.PI * FREQUENCY;
    const wd = w0 * Math.sqrt(1 - DAMPING * DAMPING);
    const decay = Math.exp(-DAMPING * w0 * seconds);
    return 1 - decay * (Math.cos(wd * seconds) + DAMPING * w0 / wd * Math.sin(wd * seconds));
}

const KEYFRAMES = 30;

function doubleValue(x) {
    const v = new GObject.Value();
    v.init(GObject.TYPE_DOUBLE);
    v.set_double(x);
    return v;
}

// A transition that follows the spring curve, sampled into keyframes
// (a custom progress function from JS doesn't reach Clutter).
function springTransition(property, from, to, duration) {
    const t = new Clutter.KeyframeTransition({
        property_name: property,
        duration,
        progress_mode: Clutter.AnimationMode.LINEAR,
    });
    t.set_from(doubleValue(from));
    t.set_to(doubleValue(to));
    const keys = [];
    const values = [];
    for (let i = 1; i < KEYFRAMES; i++) {
        const k = i / KEYFRAMES;
        keys.push(k);
        values.push(doubleValue(from + (to - from) * spring(k * duration / 1000)));
    }
    t.set_key_frames(keys);
    t.set_values(values);
    return t;
}

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

export class SpringWindows {
    enable() {
        const proto = Clutter.Actor.prototype;
        const origEase = proto.ease;
        this._origEase = origEase;

        proto.ease = function (params) {
            switch (windowAnimation(this, params)) {
            case 'open': {
                const {onStopped, onComplete} = params;
                this.set_pivot_point(0.5, 0.5);
                this.set({scale_x: OPEN_SCALE, scale_y: OPEN_SCALE, opacity: 0});
                origEase.call(this, {
                    opacity: 255,
                    duration: OPEN_FADE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                // Respect "reduce animations" (duration 0 then).
                this.save_easing_state();
                this.set_easing_duration(OPEN_TIME);
                const duration = this.get_easing_duration();
                this.restore_easing_state();
                if (duration <= 0) {
                    this.set({scale_x: 1, scale_y: 1, opacity: 255});
                    onComplete?.();
                    onStopped?.(true);
                    return;
                }
                const tx = springTransition('scale-x', OPEN_SCALE, 1, duration);
                const ty = springTransition('scale-y', OPEN_SCALE, 1, duration);
                let done = false;
                tx.connect('stopped', (_t, finished) => {
                    if (done)
                        return;
                    done = true;
                    this.remove_transition('rsx-spring-y');
                    this.set({scale_x: 1, scale_y: 1});
                    if (finished)
                        onComplete?.();
                    onStopped?.(finished);
                });
                this.add_transition('rsx-spring-y', ty);
                this.add_transition('rsx-spring-x', tx);
                return;
            }
            case 'close':
                origEase.call(this, {
                    ...params,
                    scale_x: CLOSE_SCALE,
                    scale_y: CLOSE_SCALE,
                    duration: CLOSE_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
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
