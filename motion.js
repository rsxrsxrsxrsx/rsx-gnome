// SPDX-License-Identifier: GPL-3.0-or-later
//
// Motion curves shared by the animations: modern "emphasized" easing (as in
// iOS 17 and Material 3): a quick start and a long, soft landing, no bounce.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

// CSS-style cubic-bezier(x1, y1, x2, y2) as a function of t in [0, 1].
export function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const x = s => ((ax * s + bx) * s + cx) * s;
    const dx = s => (3 * ax * s + 2 * bx) * s + cx;
    const y = s => ((ay * s + by) * s + cy) * s;
    return t => {
        if (t <= 0)
            return 0;
        if (t >= 1)
            return 1;
        // Newton's method, then bisection if it doesn't settle.
        let s = t;
        for (let i = 0; i < 8; i++) {
            const err = x(s) - t;
            if (Math.abs(err) < 1e-5)
                return y(s);
            const d = dx(s);
            if (Math.abs(d) < 1e-6)
                break;
            s -= err / d;
        }
        let lo = 0, hi = 1;
        s = t;
        for (let i = 0; i < 30; i++) {
            if (x(s) < t)
                lo = s;
            else
                hi = s;
            s = (lo + hi) / 2;
        }
        return y(s);
    };
}

// Things arriving: fast out of the gate, long gentle settle.
export const emphasized = bezier(0.05, 0.7, 0.1, 1);

const KEYFRAMES = 30;

function doubleValue(x) {
    const v = new GObject.Value();
    v.init(GObject.TYPE_DOUBLE);
    v.set_double(x);
    return v;
}

// A transition that follows `curve`, sampled into keyframes (a progress
// function written in JS can't be handed to Clutter).
export function curveTransition(property, from, to, duration, curve = emphasized) {
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
        values.push(doubleValue(from + (to - from) * curve(k)));
    }
    t.set_key_frames(keys);
    t.set_values(values);
    return t;
}
