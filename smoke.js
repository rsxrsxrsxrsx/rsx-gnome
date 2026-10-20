// SPDX-License-Identifier: GPL-3.0-or-later
//
// Colourful smoke that follows the mouse on the lock screen.
//
// A GPU fluid simulation ported from "WebGL Fluid Simulation" by Pavel
// Dobryakov (MIT License, https://github.com/PavelDoGreat/WebGL-Fluid-Simulation).
// The shaders are the original ones, adapted to Cogl snippets; every pass
// renders into an offscreen half-float texture, the last one is drawn over
// the wallpaper.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CONFIG = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    DENSITY_DISSIPATION: 1,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 30,
    SPLAT_RADIUS: 0.25,
    SPLAT_FORCE: 6000,
    COLOR_UPDATE_SPEED: 10,
    // Stop simulating this long after the mouse stops (the smoke has faded).
    IDLE_STOP_MS: 7000,
};

// -- Shaders ----------------------------------------------------------------
// Each pass gets `uv` (0..1) and the neighbour coordinates vL/vR/vT/vB.

const COMMON = `
uniform vec2 texelSize;
`;

const PRELUDE = `
vec2 vUv = cogl_tex_coord_in[0].xy;
vec2 vL = vUv - vec2(texelSize.x, 0.0);
vec2 vR = vUv + vec2(texelSize.x, 0.0);
vec2 vT = vUv + vec2(0.0, texelSize.y);
vec2 vB = vUv - vec2(0.0, texelSize.y);
`;

const SHADERS = {
    clear: {
        samplers: ['uTexture'],
        decl: 'uniform float value;',
        main: 'cogl_color_out = value * texture2D(uTexture, vUv);',
    },
    splat: {
        samplers: ['uTarget'],
        decl: 'uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;',
        main: `
            vec2 p = vUv - point.xy;
            p.x *= aspectRatio;
            vec3 splat = exp(-dot(p, p) / radius) * color;
            vec3 base = texture2D(uTarget, vUv).xyz;
            cogl_color_out = vec4(base + splat, 1.0);`,
    },
    advection: {
        samplers: ['uVelocity', 'uSource'],
        decl: 'uniform float dt; uniform float dissipation;',
        main: `
            vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
            vec4 result = texture2D(uSource, coord);
            float decay = 1.0 + dissipation * dt;
            cogl_color_out = result / decay;`,
    },
    divergence: {
        samplers: ['uVelocity'],
        decl: '',
        main: `
            float L = texture2D(uVelocity, vL).x;
            float R = texture2D(uVelocity, vR).x;
            float T = texture2D(uVelocity, vT).y;
            float B = texture2D(uVelocity, vB).y;
            vec2 C = texture2D(uVelocity, vUv).xy;
            if (vL.x < 0.0) { L = -C.x; }
            if (vR.x > 1.0) { R = -C.x; }
            if (vT.y > 1.0) { T = -C.y; }
            if (vB.y < 0.0) { B = -C.y; }
            float div = 0.5 * (R - L + T - B);
            cogl_color_out = vec4(div, 0.0, 0.0, 1.0);`,
    },
    curl: {
        samplers: ['uVelocity'],
        decl: '',
        main: `
            float L = texture2D(uVelocity, vL).y;
            float R = texture2D(uVelocity, vR).y;
            float T = texture2D(uVelocity, vT).x;
            float B = texture2D(uVelocity, vB).x;
            float vorticity = R - L - T + B;
            cogl_color_out = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);`,
    },
    vorticity: {
        samplers: ['uVelocity', 'uCurl'],
        decl: 'uniform float curl; uniform float dt;',
        main: `
            float L = texture2D(uCurl, vL).x;
            float R = texture2D(uCurl, vR).x;
            float T = texture2D(uCurl, vT).x;
            float B = texture2D(uCurl, vB).x;
            float C = texture2D(uCurl, vUv).x;
            vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
            force /= length(force) + 0.0001;
            force *= curl * C;
            force.y *= -1.0;
            vec2 velocity = texture2D(uVelocity, vUv).xy;
            velocity += force * dt;
            velocity = min(max(velocity, -1000.0), 1000.0);
            cogl_color_out = vec4(velocity, 0.0, 1.0);`,
    },
    pressure: {
        samplers: ['uPressure', 'uDivergence'],
        decl: '',
        main: `
            float L = texture2D(uPressure, vL).x;
            float R = texture2D(uPressure, vR).x;
            float T = texture2D(uPressure, vT).x;
            float B = texture2D(uPressure, vB).x;
            float divergence = texture2D(uDivergence, vUv).x;
            float pressure = (L + R + B + T - divergence) * 0.25;
            cogl_color_out = vec4(pressure, 0.0, 0.0, 1.0);`,
    },
    gradientSubtract: {
        samplers: ['uPressure', 'uVelocity'],
        decl: '',
        main: `
            float L = texture2D(uPressure, vL).x;
            float R = texture2D(uPressure, vR).x;
            float T = texture2D(uPressure, vT).x;
            float B = texture2D(uPressure, vB).x;
            vec2 velocity = texture2D(uVelocity, vUv).xy;
            velocity.xy -= vec2(R - L, T - B);
            cogl_color_out = vec4(velocity, 0.0, 1.0);`,
    },
    // Final picture with the original's light shading, premultiplied.
    display: {
        samplers: ['uTexture'],
        decl: 'uniform float opacity;',
        main: `
            vec3 c = texture2D(uTexture, vUv).rgb;
            vec3 lc = texture2D(uTexture, vL).rgb;
            vec3 rc = texture2D(uTexture, vR).rgb;
            vec3 tc = texture2D(uTexture, vT).rgb;
            vec3 bc = texture2D(uTexture, vB).rgb;
            float dx = length(rc) - length(lc);
            float dy = length(tc) - length(bc);
            vec3 n = normalize(vec3(dx, dy, length(texelSize)));
            float diffuse = clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.7, 0.7, 1.0);
            c *= diffuse;
            float a = max(c.r, max(c.g, c.b));
            cogl_color_out = vec4(c, min(a, 1.0)) * opacity;`,
    },
};

class Program {
    constructor(ctx, {samplers, decl, main}, blend = false) {
        this.samplers = samplers;
        this.pipeline = Cogl.Pipeline.new(ctx);
        const declarations = COMMON + decl + samplers.map(s => `uniform sampler2D ${s};`).join('\n');
        const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, null);
        snippet.set_replace(PRELUDE + main);
        this.pipeline.add_snippet(snippet);
        if (!blend)
            this.pipeline.set_blend('RGBA = ADD(SRC_COLOR, 0)');
        samplers.forEach((s, i) => {
            this.pipeline.set_layer_filters(i, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
            this.pipeline.set_layer_wrap_mode(i, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
            this.pipeline.set_uniform_1i(this.pipeline.get_uniform_location(s), i);
        });
        this._locations = new Map();
    }

    _loc(name) {
        let loc = this._locations.get(name);
        if (loc === undefined) {
            loc = this.pipeline.get_uniform_location(name);
            this._locations.set(name, loc);
        }
        return loc;
    }

    set(name, ...values) {
        if (values.length === 1)
            this.pipeline.set_uniform_1f(this._loc(name), values[0]);
        else
            this.pipeline.set_uniform_float(this._loc(name), values.length, 1, values);
    }

    textures(...targets) {
        targets.forEach((t, i) => this.pipeline.set_layer_texture(i, t.texture));
    }
}

class Target {
    constructor(ctx, width, height) {
        this.width = width;
        this.height = height;
        this.texelSizeX = 1 / width;
        this.texelSizeY = 1 / height;
        this.texture = Cogl.Texture2D.new_with_format(ctx, width, height,
            Cogl.PixelFormat.RGBA_FP_16161616);
        this.texture.set_premultiplied(false);
        this.framebuffer = Cogl.Offscreen.new_with_texture(this.texture);
        this.framebuffer.allocate();
        this.framebuffer.orthographic(0, 0, width, height, -1, 1);
        this.framebuffer.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);
    }
}

class DoubleTarget {
    constructor(ctx, width, height) {
        this.read = new Target(ctx, width, height);
        this.write = new Target(ctx, width, height);
        this.width = width;
        this.height = height;
        this.texelSizeX = this.read.texelSizeX;
        this.texelSizeY = this.read.texelSizeY;
    }

    swap() {
        [this.read, this.write] = [this.write, this.read];
    }
}

// Flush right away: Cogl batches drawing per framebuffer, and ping-ponging
// between two textures would otherwise create a dependency cycle.
function blit(program, target) {
    target.framebuffer.draw_rectangle(program.pipeline, 0, 0, target.width, target.height);
    target.framebuffer.flush();
}

function resolution(res, width, height) {
    let aspect = width / height;
    if (aspect < 1)
        aspect = 1 / aspect;
    const min = Math.round(res);
    const max = Math.round(res * aspect);
    return width > height ? [max, min] : [min, max];
}

function hsvToRgb(h, s, v) {
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

function randomColor() {
    return hsvToRgb(Math.random(), 1, 1).map(c => c * 0.15);
}

// -- The actor ----------------------------------------------------------------

export const SmokeActor = GObject.registerClass(
class SmokeActor extends Clutter.Actor {
    _init() {
        super._init({reactive: false});
        this._ready = false;
        this._failed = false;
        this._pointer = {x: 0, y: 0, dx: 0, dy: 0, moved: false, known: false};
        this._color = randomColor();
        this._colorTimer = 0;
        this._lastTime = 0;
        this._lastMove = 0;

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this.queue_redraw());
        this.connect('destroy', () => {
            this._timeline.stop();
            this._timeline = null;
        });
    }

    // Stage coordinates of the pointer.
    pointerMoved(x, y) {
        const [ok, lx, ly] = this.transform_stage_point(x, y);
        if (!ok || this.width <= 0 || this.height <= 0)
            return;
        const p = this._pointer;
        const nx = lx / this.width, ny = ly / this.height;
        if (p.known) {
            let dx = nx - p.x, dy = ny - p.y;
            const aspect = this.width / this.height;
            if (aspect < 1)
                dx *= aspect;
            else
                dy /= aspect;
            p.dx += dx;
            p.dy += dy;
            p.moved = Math.abs(p.dx) > 0 || Math.abs(p.dy) > 0;
        }
        p.x = nx;
        p.y = ny;
        p.known = true;
        this._lastMove = GLib.get_monotonic_time();
        if (!this._timeline.is_playing()) {
            this._lastTime = 0;
            this._timeline.start();
        }
    }

    _init_gl() {
        const ctx = global.stage.context.get_backend().get_cogl_context();
        const programs = {};
        for (const [name, source] of Object.entries(SHADERS))
            programs[name] = new Program(ctx, source, name === 'display');
        this._programs = programs;

        const [w, h] = [Math.max(1, this.width), Math.max(1, this.height)];
        const [simW, simH] = resolution(CONFIG.SIM_RESOLUTION, w, h);
        const [dyeW, dyeH] = resolution(CONFIG.DYE_RESOLUTION, w, h);
        this._dye = new DoubleTarget(ctx, dyeW, dyeH);
        this._velocity = new DoubleTarget(ctx, simW, simH);
        this._divergence = new Target(ctx, simW, simH);
        this._curl = new Target(ctx, simW, simH);
        this._pressure = new DoubleTarget(ctx, simW, simH);
        this._size = [w, h];
        this._ready = true;
    }

    _splat(x, y, dx, dy, color) {
        const p = this._programs.splat;
        const aspect = this.width / this.height;
        let radius = CONFIG.SPLAT_RADIUS / 100;
        if (aspect > 1)
            radius *= aspect;
        p.set('aspectRatio', aspect);
        p.set('point', x, y);
        p.set('radius', radius);
        p.set('texelSize', this._velocity.texelSizeX, this._velocity.texelSizeY);

        p.textures(this._velocity.read);
        p.set('color', dx, dy, 0);
        blit(p, this._velocity.write);
        this._velocity.swap();

        p.textures(this._dye.read);
        p.set('color', ...color);
        blit(p, this._dye.write);
        this._dye.swap();
    }

    _step(dt) {
        const P = this._programs;
        const vel = this._velocity;
        const texel = [vel.texelSizeX, vel.texelSizeY];

        P.curl.set('texelSize', ...texel);
        P.curl.textures(vel.read);
        blit(P.curl, this._curl);

        P.vorticity.set('texelSize', ...texel);
        P.vorticity.set('curl', CONFIG.CURL);
        P.vorticity.set('dt', dt);
        P.vorticity.textures(vel.read, this._curl);
        blit(P.vorticity, vel.write);
        vel.swap();

        P.divergence.set('texelSize', ...texel);
        P.divergence.textures(vel.read);
        blit(P.divergence, this._divergence);

        P.clear.set('texelSize', ...texel);
        P.clear.set('value', CONFIG.PRESSURE);
        P.clear.textures(this._pressure.read);
        blit(P.clear, this._pressure.write);
        this._pressure.swap();

        P.pressure.set('texelSize', ...texel);
        for (let i = 0; i < CONFIG.PRESSURE_ITERATIONS; i++) {
            P.pressure.textures(this._pressure.read, this._divergence);
            blit(P.pressure, this._pressure.write);
            this._pressure.swap();
        }

        P.gradientSubtract.set('texelSize', ...texel);
        P.gradientSubtract.textures(this._pressure.read, vel.read);
        blit(P.gradientSubtract, vel.write);
        vel.swap();

        P.advection.set('texelSize', ...texel);
        P.advection.set('dt', dt);
        P.advection.set('dissipation', CONFIG.VELOCITY_DISSIPATION);
        P.advection.textures(vel.read, vel.read);
        blit(P.advection, vel.write);
        vel.swap();

        P.advection.set('dissipation', CONFIG.DENSITY_DISSIPATION);
        P.advection.textures(vel.read, this._dye.read);
        blit(P.advection, this._dye.write);
        this._dye.swap();
    }

    _frame() {
        const now = GLib.get_monotonic_time();
        const dt = this._lastTime ? Math.min((now - this._lastTime) / 1e6, 0.016666) : 0.016666;
        this._lastTime = now;

        this._colorTimer += dt * CONFIG.COLOR_UPDATE_SPEED;
        if (this._colorTimer >= 1) {
            this._colorTimer %= 1;
            this._color = randomColor();
        }

        const p = this._pointer;
        if (p.moved) {
            p.moved = false;
            this._splat(p.x, p.y, p.dx * CONFIG.SPLAT_FORCE, p.dy * CONFIG.SPLAT_FORCE, this._color);
            p.dx = p.dy = 0;
        }
        this._step(dt);

        if ((now - this._lastMove) / 1000 > CONFIG.IDLE_STOP_MS)
            this._timeline.stop();
    }

    vfunc_paint(paintContext) {
        if (this._failed || this.width <= 0 || this.height <= 0)
            return;
        try {
            if (!this._ready)
                this._init_gl();
            if (this._timeline?.is_playing())
                this._frame();

            const d = this._programs.display;
            d.set('texelSize', this._dye.texelSizeX, this._dye.texelSizeY);
            d.set('opacity', this.get_paint_opacity() / 255);
            d.textures(this._dye.read);
            paintContext.get_framebuffer().draw_rectangle(d.pipeline, 0, 0, this.width, this.height);
        } catch (e) {
            this._failed = true;
            console.error(`rsx@rsx: smoke disabled: ${e}`);
        }
    }
});

// -- Feature: attach the smoke to the unlock dialog --------------------------

export class LockSmoke {
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
        this._actor = new SmokeActor();
        this._actor.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        dialog.add_child(this._actor);
        this._restack();
        dialog.connectObject(
            'child-added', () => this._restack(),
            'captured-event', (_a, event) => {
                if (event.type() === Clutter.EventType.MOTION)
                    this._actor?.pointerMoved(...event.get_coords());
                return Clutter.EVENT_PROPAGATE;
            },
            'destroy', () => {
                this._dialog = null;
                this._actor = null;
            }, this);
    }

    // Above the wallpaper (and its blurred copy), below the clock and prompt.
    _restack() {
        const dialog = this._dialog;
        const content = dialog?._stack?.get_parent();
        if (!this._actor || !content || content.get_parent() !== dialog)
            return;
        dialog.set_child_below_sibling(this._actor, content);
    }

    _detach() {
        this._dialog?.disconnectObject(this);
        this._actor?.destroy();
        this._actor = null;
        this._dialog = null;
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        Main.screenShield?.disconnectObject(this);
        this._detach();
    }
}
