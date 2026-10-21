// SPDX-License-Identifier: GPL-3.0-or-later
//
// A little person living on the desktop, under the windows.
//
// He runs along the bottom, stops, waves, chases the cursor and dodges it,
// climbs onto windows and runs along their tops, dances while music plays,
// falls asleep when you're away, runs to new notifications, gets tired on a
// low battery and hot under heavy load, and now and then drags a window a
// little. He talks in a speech bubble (and reminds you to drink water, take a
// break and go to bed).
//
// - Point at him: he stops and waves. Tickle him (wiggle the pointer over
//   him): he laughs. Stroke him slowly: hearts.
// - Drag him: he hangs from where you grabbed him and swings. Let go: he
//   falls, lands on windows, can be thrown; from high up he falls flat.
//   Thrown up to the top bar, he hangs on it for a bit.
// - Right click: he jumps.
// - Click fast: you hit him. Enough hits and he's knocked out. Hit him a lot
//   and he sulks with his back to you until you stroke him.
//
// Poses come from sprite sheets in ./sprites (one row of 8 frames each).
// Only run.png and front.png are required; the others add poses when present.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {MprisSource} from 'resource:///org/gnome/shell/ui/mpris.js';
import {_} from './i18n.js';
import {greetingText} from './greeting.js';

// Frames of each sheet. Side views face right (mirrored for left).
const SHEETS = {
    run: {}, // running cycle, side
    front: {}, // 0 stand, 2 blink, 4–7 wave
    sit: {seat: 0.581}, // 0–3 legs swinging, 4 yawn, 5 drowsy, 6 dozing, 7 asleep
    dance: {}, // dance loop
    tired: {}, // tired walk, side
    moods: {}, // 0–1 fanning, 2–3 laughing, 4–5 pointing up, 6–7 back turned
    hang: {}, // 0–3 hanging by the hands, 4–7 pulling (side)
};
const FRAMES = 8;
const SHEET_SCALE = 0.5; // sheet px -> logical px (sheets are drawn at 2×)

const STAND = 0;
const BLINK = 2; // eyes closed
const WAVE = [4, 5, 6, 5, 4, 5, 6, 7];

const SPEED = 110; // logical px per second
const RUN_FPS = 11;
const WAVE_FPS = 6;

const GRAVITY = 2600; // logical px/s²
const HARD_LANDING = 1500; // fall speed that knocks him over
const BOUNCE_SPEED = 450; // below this he just lands
const JUMP_SPEED = 1000;
const DRAG_START = 6; // px the pointer moves before a press becomes a drag
const QUICK_CLICK = 0.45; // s between clicks that count as hitting
const KO_HITS = 4; // hits within KO_WINDOW knock him out
const KO_WINDOW = 2.5;
const SULK_HITS = 10; // hits within a minute make him sulk
const SULK_TIME = 40;
const SLEEP_AFTER = 120; // s of no input before he falls asleep

const SWING_STIFFNESS = 90; // how fast he tilts back upright
const SWING_DAMPING = 7;
const HIT_KICK = 190; // deg/s of tilt per hit

const SOUNDS = ['hit', 'fall', 'laugh'];

const random = (min, max) => min + Math.random() * (max - min);
const chance = p => Math.random() < p;
const pick = list => list[Math.floor(Math.random() * list.length)];
const now = () => GLib.get_monotonic_time() / 1e6;

// What he says, in rsx's language (source strings are English, see i18n.js).
const SAY = {
    hit: () => pick([_('Ouch!'), _('Hey!'), _('What was that for?!'), _('That hurts!')]),
    grabbed: () => pick([_('Put me down!'), _('Whoa!'), _('Heeey!')]),
    dropped: () => pick([_('Ow…'), _('My back…')]),
    chatter: () => pick([_('Hi!'), _('What are you up to?'), _('I\'m watching you 👀'),
        _('Nice wallpaper'), _('Don\'t mind me')]),
    hot: () => _('Phew, it\'s hot in here 🥵'),
    tired: () => _('So tired… charge me 🔋'),
    tickled: () => pick([_('Haha, that tickles!'), _('Stop it, haha!')]),
    sulk: () => _('I\'m not talking to you 😤'),
    friends: () => _('Okay, friends again ❤️'),
    notification: () => _('You\'ve got a message!'),
    woke: () => pick([_('Huh? I wasn\'t sleeping!'), _('I\'m up, I\'m up!')]),
    prank: () => _('Hehe 😈'),
    water: () => _('Time to drink some water 💧'),
    stretch: () => _('You\'ve been sitting for 2 hours. Stretch a bit!'),
    night: time => _('It\'s %s already, go to sleep 😴').replace('%s', time),
};

export class Runner {
    constructor(settings, extension) {
        this._settings = settings;
        this._dir = extension.path;
    }

    enable() {
        this._enabled = true;
        this._actor = new St.Widget({
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
            visible: false,
        });
        this._loadSheets();
        this._loadSounds();
        this._flash = new Clutter.BrightnessContrastEffect({enabled: false});
        this._actor.add_effect(this._flash);
        global.window_group.add_child(this._actor);

        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._x = null; // feet position, stage px
        this._y = null;
        this._facing = 1; // 1 = right, -1 = left
        this._angle = 0; // tilt, degrees
        this._angVel = 0;
        this._bounce = 0; // little hops, px up
        this._perch = null; // the window he stands on
        this._onTop = false; // above all windows (held, thrown)
        this._hits = [];
        this._abuse = [];
        this._lastClick = 0;
        this._labels = new Set();
        this._ptr = {x: 0, y: 0, vx: 0, vy: 0, swings: [], petTime: 0, lastDodge: 0};
        this._env = {music: false, hot: false, tired: false, checked: 0, load: 0};
        this._reminders = {activeSince: now(), water: now(), stretch: 0, night: 0};
        this._run(chance(0.5) ? 1 : -1);

        this._actor.connectObject(
            'button-press-event', (_a, event) => this._onPress(event),
            'motion-event', (_a, event) => this._onMotion(event),
            'button-release-event', (_a, event) => this._onRelease(event),
            this);

        this._timeline = new Clutter.Timeline({actor: this._actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._last = 0;
        // On shell shutdown the actor can go away before disable().
        this._actor.connect('destroy', () => {
            this._timeline?.stop();
            this._timeline = null;
            this._actor = null;
        });

        global.display.connectObject(
            'in-fullscreen-changed', () => this._syncVisible(),
            'restacked', () => this._restack(), this);
        global.workspace_manager.connectObject('active-workspace-changed',
            () => this._fallOff(), this);
        Main.sessionMode.connectObject('updated', () => this._syncVisible(), this);
        Main.overview.connectObject(
            'showing', () => this._syncVisible(),
            'hidden', () => this._syncVisible(), this);

        // Say hello after logging in.
        if (Main.layoutManager._startingUp)
            this._greetPending = true;
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._syncVisible(),
            'startup-complete', () => {
                this._syncVisible();
                if (this._greetPending)
                    this._later(1500, () => this._greet());
            }, this);

        this._watchWorld();
        this._restack();
        this._syncVisible();
    }

    // -- setup -------------------------------------------------------------------

    _loadSheets() {
        this._sheets = {};
        for (const [name, extra] of Object.entries(SHEETS)) {
            const path = `${this._dir}/sprites/${name}.png`;
            let info = [null, 0, 0];
            try {
                info = GdkPixbuf.Pixbuf.get_file_info(path);
            } catch {}
            const [format, width, height] = info;
            if (!format)
                continue;
            const uri = GLib.filename_to_uri(path, null);
            const widget = new St.Widget({
                style: `background-image: url("${uri}");
                        background-size: ${width * SHEET_SCALE}px ${height * SHEET_SCALE}px;`,
                visible: false,
            });
            this._actor.add_child(widget);
            this._sheets[name] = {...extra, width, height, widget};
        }
    }

    _has(name) {
        return !!this._sheets[name];
    }

    _loadSounds() {
        this._sounds = {};
        const dir = Gio.File.new_for_path(`${this._dir}/sprites/sounds`);
        try {
            const files = dir.enumerate_children('standard::name', 0, null);
            let info;
            while ((info = files.next_file(null))) {
                const name = info.get_name();
                const key = SOUNDS.find(s => name.startsWith(s));
                if (key)
                    (this._sounds[key] ??= []).push(dir.get_child(name));
            }
        } catch {}
    }

    _play(name) {
        const files = this._sounds[name];
        if (!files || !this._settings.get_boolean('runner-sounds'))
            return;
        global.display.get_sound_player().play_from_file(pick(files), name, null);
    }

    // Music, notifications, idle, battery.
    _watchWorld() {
        this._mpris = new MprisSource();

        const watch = source => source.connectObject('notification-request-banner',
            () => this._onNotification(), this);
        Main.messageTray.getSources().forEach(watch);
        Main.messageTray.connectObject(
            'source-added', (_t, source) => watch(source),
            'source-removed', (_t, source) => source.disconnectObject(this), this);

        this._idle = global.backend.get_core_idle_monitor();
        this._idleWatch = this._idle.add_idle_watch(SLEEP_AFTER * 1000, () => this._fallAsleep());

        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device', null, (_o, res) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(res);
                    if (this._enabled)
                        this._upower = proxy;
                } catch {}
            });

        // Reminders: checked every 30 s.
        this._reminderId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this._checkReminders();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updateEnv(t) {
        const env = this._env;
        if (t - env.checked < 2)
            return;
        env.checked = t;
        env.music = (this._mpris?.players ?? []).some(p => p.status === 'Playing');

        const prop = name => this._upower?.get_cached_property(name)?.unpack();
        env.tired = !!prop('IsPresent') && prop('State') === 2 && prop('Percentage') < 20;

        if (t - (env.loadChecked ?? 0) > 10) {
            env.loadChecked = t;
            try {
                const [, bytes] = GLib.file_get_contents('/proc/loadavg');
                env.load = parseFloat(new TextDecoder().decode(bytes));
            } catch {}
            env.hot = env.load / GLib.get_num_processors() > 0.7;
        }
    }

    _checkReminders() {
        if (!this._settings.get_boolean('runner-speech') || !this._actor?.visible)
            return;
        const r = this._reminders;
        const t = now();
        const idle = this._idle.get_idletime() / 1000;
        if (idle > 300) {
            r.activeSince = t; // a break counts
            return;
        }
        const date = GLib.DateTime.new_now_local();
        const hour = date.get_hour();
        if (hour >= 1 && hour < 5 && t - r.night > 30 * 60) {
            r.night = t;
            this._say(SAY.night(date.format('%H:%M')), true);
        } else if (t - r.activeSince > 2 * 3600 && t - r.stretch > 30 * 60) {
            r.stretch = t;
            this._say(SAY.stretch(), true);
        } else if (t - r.water > 90 * 60) {
            r.water = t;
            this._say(SAY.water(), true);
        }
    }

    _later(ms, fn) {
        this._timeouts ??= new Set();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    // -- layers and visibility ---------------------------------------------------

    // Normally right above the wallpaper (under all windows); on top of the
    // window he stands on; above everything while held or thrown.
    _restack() {
        const group = global.window_group;
        if (!this._actor || this._actor.get_parent() !== group)
            return;
        if (this._onTop) {
            group.set_child_above_sibling(this._actor, null);
            return;
        }
        let below = this._perch?.get_compositor_private() ?? null;
        if (!below) {
            below = Main.layoutManager._backgroundGroup;
            for (const actor of global.get_window_actors()) {
                if (actor.meta_window?.get_window_type() === Meta.WindowType.DESKTOP)
                    below = actor;
            }
        }
        if (below?.get_parent() === group)
            group.set_child_above_sibling(this._actor, below);
        else
            group.set_child_below_sibling(this._actor, null);
    }

    _setOnTop(onTop) {
        if (this._onTop === onTop)
            return;
        this._onTop = onTop;
        this._restack();
    }

    // Not while a fullscreen app, the overview or the lock screen is up.
    _syncVisible() {
        if (!this._actor)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        const show = !!monitor && !monitor.inFullscreen &&
            !Main.overview.visible && !Main.sessionMode.isLocked &&
            !Main.layoutManager._startingUp;
        this._actor.visible = show;
        for (const label of this._labels)
            label.visible = show;
        if (show && !this._timeline.is_playing()) {
            this._last = 0;
            this._timeline.start();
        } else if (!show) {
            this._timeline.stop();
            this._endDrag();
        }
    }

    // Windows people can see right now, bottom to top.
    _visibleWindows() {
        const ws = global.workspace_manager.get_active_workspace();
        return global.get_window_actors().filter(actor => {
            const w = actor.meta_window;
            return actor.visible && w && w.showing_on_its_workspace() &&
                w.located_on_workspace(ws) &&
                w.get_window_type() !== Meta.WindowType.DESKTOP;
        });
    }

    // Is the point under a window (above `above`, if given)?
    _covered(x, y, above = null) {
        const actors = this._visibleWindows();
        const start = above ? actors.indexOf(above) + 1 : 0;
        for (const actor of actors.slice(start)) {
            const r = actor.meta_window.get_frame_rect();
            if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
                return true;
        }
        return false;
    }

    _isHidden() {
        if (!this._actor?.visible)
            return true;
        if (this._onTop)
            return false;
        const above = this._perch?.get_compositor_private() ?? null;
        return this._covered(this._x, this._y - this._actor.height * 0.7, above);
    }

    // -- the window he stands on -------------------------------------------------

    _surface(work) {
        const r = this._perch?.get_frame_rect();
        if (r)
            return {y: r.y, x1: r.x, x2: r.x + r.width};
        return {y: work.y + work.height, x1: work.x, x2: work.x + work.width};
    }

    _perchOn(win) {
        this._perch?.disconnectObject(this);
        this._perch = win;
        win?.connectObject(
            'position-changed', () => this._fallOff(),
            'size-changed', () => this._fallOff(),
            'unmanaging', () => this._fallOff(),
            'notify::minimized', () => this._fallOff(),
            this);
        this._restack();
    }

    // The window moved or went away under him.
    _fallOff() {
        if (!this._perch)
            return;
        this._perchOn(null);
        if (['held', 'fall', 'hang'].includes(this._state))
            return;
        this._setOnTop(true);
        this._vx = 0;
        this._vy = 0;
        this._jumping = false;
        this._setPivot(0.5, 1);
        this._set('fall');
    }

    // Window tops he could stand on: not maximized, with room above.
    _standableWindows(panelBottom) {
        const h = this._actor.height;
        return this._visibleWindows().filter(actor => {
            const w = actor.meta_window;
            if (w.get_window_type() !== Meta.WindowType.NORMAL || w.is_maximized() ||
                w.is_fullscreen())
                return false;
            const r = w.get_frame_rect();
            return r.width > 120 && r.y - h > panelBottom + 10;
        });
    }

    _landingWindow(prevY, newY, x, panelBottom) {
        for (const actor of this._standableWindows(panelBottom).reverse()) {
            const r = actor.meta_window.get_frame_rect();
            if (x > r.x + 10 && x < r.x + r.width - 10 && prevY <= r.y && newY >= r.y &&
                !this._covered(x, r.y - 4, actor))
                return actor.meta_window;
        }
        return null;
    }

    // -- states ------------------------------------------------------------------

    _set(state, seconds = Infinity) {
        this._state = state;
        this._time = 0;
        this._until = seconds;
    }

    _run(dir, flee = false, seconds = null) {
        this._set('run', seconds ?? (flee ? random(2, 3) : random(7, 18)));
        this._facing = dir;
        this._flee = flee;
    }

    _stand(seconds) {
        this._set('stand', seconds);
        this._blinkAt = random(0.4, Math.max(0.5, seconds - 0.4));
        if (chance(0.08))
            this._say(SAY.chatter());
    }

    _wave() {
        this._flee = false;
        this._set('wave', WAVE.length / WAVE_FPS);
    }

    _knockOut(dir, seconds) {
        this._set('ko', seconds);
        this._koDir = dir;
        this._setPivot(0.5, 1);
        this._showLabel('💫', 'stars');
        this._play('fall');
    }

    _runAway() {
        this._run(this._ptr.x < this._x ? 1 : -1, true);
    }

    _calm() {
        return ['run', 'stand', 'wave', 'chase', 'dance', 'sit', 'fan'].includes(this._state) &&
            !this._flee;
    }

    // What to do after a run: stand and wave, or something else.
    _next(work, panelBottom) {
        const env = this._env;
        const pranks = this._settings.get_boolean('runner-pranks');
        if (env.music && chance(0.6) && !this._perch) {
            this._set('dance', random(6, 10));
        } else if (env.hot && chance(0.5)) {
            this._set('fan', 3);
            this._sweated = false;
            if (chance(0.3))
                this._say(SAY.hot());
        } else if (env.tired && chance(0.3)) {
            this._stand(2);
            this._say(SAY.tired());
        } else if (this._perch && this._has('sit') && chance(0.6)) {
            this._set('sit', random(10, 30));
        } else if (pranks && !this._perch && chance(0.15) && this._startPrank(work)) {
            // walking over to a window
        } else if (!this._perch && chance(0.2) && this._climb(panelBottom)) {
            // jumping onto a window
        } else if (chance(0.25)) {
            this._set('chase', 6);
        } else {
            this._stand(random(1.5, 3));
        }
    }

    _greet() {
        this._greetPending = false;
        if (!this._actor)
            return;
        const work = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        this._perchOn(null);
        this._setOnTop(false);
        this._x = work.x - 60 * this._scale;
        this._y = work.y + work.height;
        this._facing = 1;
        this._flee = false;
        this._set('greet');
    }

    _onNotification() {
        if (!this._actor?.visible)
            return;
        if (this._state === 'sleep')
            this._wake(false);
        if (!this._calm() && this._state !== 'waking')
            return;
        this._set('notify', 5);
    }

    _fallAsleep() {
        if (!this._calm())
            return;
        this._set('sleep');
        this._sleepDir = chance(0.5) ? 1 : -1;
        this._zzz = 0;
        this._setPivot(0.5, 1);
        this._activeWatch = this._idle.add_user_active_watch(() => {
            this._activeWatch = 0;
            this._wake(true);
        });
    }

    _wake(talk) {
        if (this._activeWatch) {
            this._idle.remove_watch(this._activeWatch);
            this._activeWatch = 0;
        }
        if (this._state !== 'sleep')
            return;
        this._set('waking', 0.6);
        if (talk && chance(0.4))
            this._say(SAY.woke());
    }

    _sulk() {
        this._set('sulk', Math.max(1, this._sulkEnd - now()));
        this._say(SAY.sulk());
    }

    // -- jumps -------------------------------------------------------------------

    _jump(vx = 0, vy = -JUMP_SPEED * this._scale) {
        // Leaving a window: stay in front of it while in the air.
        if (this._perch) {
            this._perchOn(null);
            this._setOnTop(true);
        }
        this._vx = vx;
        this._vy = vy;
        this._jumping = true;
        this._setPivot(0.5, 1);
        this._set('fall');
    }

    // Jump up onto a window whose top is free.
    _climb(panelBottom) {
        const wins = this._standableWindows(panelBottom).filter(actor => {
            const r = actor.meta_window.get_frame_rect();
            return !this._covered(r.x + r.width / 2, r.y - 4, actor);
        });
        if (!wins.length)
            return false;
        const r = pick(wins).meta_window.get_frame_rect();
        const s = this._scale;
        const g = GRAVITY * s;
        const tx = Math.clamp(this._x, r.x + 40 * s, r.x + r.width - 40 * s);
        const vy = -Math.sqrt(2 * g * (this._y - r.y + 30 * s));
        const flight = -vy / g + Math.sqrt(2 * 30 * s / g);
        this._setOnTop(true);
        this._jump((tx - this._x) / flight, vy);
        return true;
    }

    // -- the prank: drag a window a little ----------------------------------------

    _startPrank(work) {
        const half = this._cellWidth('run') / 2;
        const ground = work.y + work.height;
        const options = [];
        for (const actor of this._visibleWindows()) {
            const w = actor.meta_window;
            if (w.get_window_type() !== Meta.WindowType.NORMAL || w.is_maximized() ||
                w.is_fullscreen())
                continue;
            const r = w.get_frame_rect();
            // The bottom of the window must be within his reach.
            if (r.y + r.height < ground - this._actor.height * 0.6)
                continue;
            for (const side of [-1, 1]) {
                const x = side < 0 ? r.x - half : r.x + r.width + half;
                if (x - half > work.x && x + half < work.x + work.width &&
                    !this._covered(x, ground - 10))
                    options.push({win: w, x, side, rect: r});
            }
        }
        if (!options.length)
            return false;
        this._prank = pick(options);
        this._set('goto', 8);
        return true;
    }

    // -- input -------------------------------------------------------------------

    _onPress(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            if (this._state === 'sleep')
                this._wake(true);
            else if (this._calm())
                this._jump(this._state === 'run' ? this._facing * SPEED * this._scale : 0);
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        this._press = {x: px, y: py};
        this._grab = global.stage.grab(this._actor);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        if (this._state !== 'held' &&
            Math.hypot(px - this._press.x, py - this._press.y) > DRAG_START)
            this._startDrag(this._press.x, this._press.y);
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._press || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = event.get_coords();
        if (this._state !== 'held')
            this._click(px, py);
        this._endDrag();
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
        this._press = null;
        if (this._state === 'held')
            this._drop();
    }

    _startDrag(px, py) {
        this._wake(false);
        this._clearLabel('stars');
        this._prank = null;
        this._perchOn(null);
        this._setOnTop(true);
        this._set('held');
        this._show('front', STAND);
        this._bounce = 0;
        // Hang from the point where he was grabbed.
        const {width: w, height: h} = this._actor;
        const left = this._x - w / 2;
        const top = this._y - h;
        this._setPivot(
            Math.clamp((px - left) / w, 0.1, 0.9),
            Math.clamp((py - top) / h, 0.02, 0.9));
        this._ptr.vx = this._ptr.vy = 0;
        if (chance(0.3))
            this._say(SAY.grabbed());
    }

    _drop() {
        const limit = 2500 * this._scale;
        this._vx = Math.clamp(this._ptr.vx, -limit, limit);
        this._vy = Math.clamp(this._ptr.vy, -limit, limit);
        this._jumping = false;
        this._set('fall');
    }

    _click(px, py) {
        const t = now();
        const quick = t - this._lastClick < QUICK_CLICK;
        this._lastClick = t;
        if (this._state === 'sleep') {
            this._wake(true);
        } else if (this._state === 'hang') {
            this._vx = this._vy = 0;
            this._set('fall');
        } else if (quick || this._flee || ['hurt', 'ko', 'sulk'].includes(this._state)) {
            this._hit(px, py);
        } else if (this._calm()) {
            this._wave();
        }
    }

    _hit(px, py) {
        const t = now();
        this._hits = this._hits.filter(h => t - h < KO_WINDOW);
        this._hits.push(t);
        this._abuse = this._abuse.filter(h => t - h < 60);
        this._abuse.push(t);
        if (this._abuse.length >= SULK_HITS && !this._sulky) {
            this._sulky = true;
            this._sulkEnd = t + SULK_TIME;
        }

        // Knocked away from the side he was hit on.
        const dir = px < this._x ? 1 : -1;
        this._angVel += dir * HIT_KICK * random(0.8, 1.2);
        this._showLabel(pick(['💥', '💢', '⭐']), null, px, py);
        this._flashRed();
        this._play('hit');

        if (this._state === 'ko') {
            this._until = Math.max(this._until, this._time + 1.5);
            return;
        }
        if (this._hits.length >= KO_HITS) {
            this._hits = [];
            this._flee = false;
            this._knockOut(dir, 3);
            return;
        }
        if (this._state !== 'hurt' && chance(0.35))
            this._say(SAY.hit());
        this._flee = false;
        this._setPivot(0.5, 1);
        this._set('hurt', 1.2);
    }

    // Pointer: speed, tickling (fast wiggle over him) and stroking (slow).
    _trackPointer(dt, hovered) {
        const p = this._ptr;
        const [px, py] = global.get_pointer();
        if (dt > 0) {
            p.vx = p.vx * 0.6 + (px - p.x) / dt * 0.4;
            p.vy = p.vy * 0.6 + (py - p.y) / dt * 0.4;
        }
        const dx = px - p.x;
        p.x = px;
        p.y = py;
        if (!hovered) {
            p.swings = [];
            p.petTime = Math.max(0, p.petTime - dt);
            return;
        }
        const t = now();
        const speed = Math.hypot(p.vx, p.vy) / this._scale;
        // Tickling: direction changes while moving fast.
        if (dx !== 0) {
            const dir = Math.sign(dx);
            if (p.dir && dir !== p.dir && speed > 500)
                p.swings.push(t);
            p.dir = dir;
        }
        p.swings = p.swings.filter(s => t - s < 1.2);
        if (p.swings.length >= 4) {
            p.swings = [];
            this._onTickle();
        }
        // Stroking: slow movement over him.
        if (speed > 15 && speed < 450) {
            p.petTime += dt;
            if (p.petTime > 1.3) {
                p.petTime = 0;
                this._onPet();
            }
        }
    }

    _onTickle() {
        if (this._state === 'laugh') {
            this._until = this._time + 1.2; // keeps laughing while tickled
            return;
        }
        if (this._sulky || !this._calm())
            return;
        this._set('laugh', 1.6);
        this._play('laugh');
        if (chance(0.4))
            this._say(SAY.tickled());
    }

    _onPet() {
        if (['held', 'fall', 'hang'].includes(this._state))
            return;
        this._showLabel('❤️', null, this._x, this._y - this._actor.height * 1.05);
        if (this._sulky) {
            this._sulky = false;
            this._abuse = [];
            this._say(SAY.friends());
            if (this._state === 'sulk' || this._flee)
                this._wave();
        }
    }

    // Moving fast at him: he jumps out of the way.
    _maybeDodge(t) {
        const p = this._ptr;
        const s = this._scale;
        const h = this._actor.height;
        if (t - p.lastDodge < 1.5 || !['run', 'stand', 'chase', 'sulk', 'dance'].includes(this._state))
            return;
        const dx = this._x - p.x;
        const dy = this._y - h / 2 - p.y;
        if (Math.abs(dx) > 160 * s || Math.abs(dy) > h)
            return;
        const speed = Math.hypot(p.vx, p.vy);
        const toward = (p.vx * dx + p.vy * dy) / (Math.hypot(dx, dy) || 1);
        const threshold = (this._sulky ? 900 : 1800) * s;
        if (speed < threshold || toward < speed * 0.6 || this._isHidden())
            return;
        p.lastDodge = t;
        const away = dx >= 0 ? 1 : -1;
        this._facing = away;
        this._flee = false;
        this._jump(away * 450 * s, -700 * s);
    }

    // -- every frame -------------------------------------------------------------

    _tick() {
        const t = now();
        const dt = this._last ? Math.min(t - this._last, 0.05) : 0;
        this._last = t;
        this._time += dt;

        const work = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const panelBox = Main.layoutManager.panelBox;
        const panelBottom = panelBox.visible ? panelBox.y + panelBox.height : work.y;
        const surface = this._surface(work);
        this._x ??= work.x + random(0.2, 0.8) * work.width;
        this._y ??= surface.y;
        const hovered = this._actor.hover && !this._press;

        this._updateEnv(t);
        this._trackPointer(dt, hovered);
        this._maybeDodge(t);

        this._bounce = 0;
        const ctx = {t, dt, work, surface, panelBottom, hovered};
        const [sheet, frame, mirror = false, target = 0] =
            this[`_tick_${this._state}`](ctx) ?? ['front', STAND];

        this._swing(target, dt);
        this._show(sheet, frame, mirror);
        this._place();
    }

    // Move along the surface. Returns the running frame.
    _move(ctx, speedMul, fpsMul = 1) {
        this._x += this._facing * SPEED * speedMul * this._scale * ctx.dt;
        this._y = ctx.surface.y;
        return Math.floor(this._time * RUN_FPS * fpsMul) % FRAMES;
    }

    // Keep him on the surface; returns the edge he reached (-1, 1) or 0.
    _edge(ctx) {
        const half = this._cellWidth('run') / 2;
        const {x1, x2} = ctx.surface;
        if (this._x < x1 + half) {
            this._x = x1 + half;
            return -1;
        }
        if (this._x > x2 - half) {
            this._x = x2 - half;
            return 1;
        }
        return 0;
    }

    _tick_run(ctx) {
        const tired = this._env.tired && !this._flee;
        const sheet = tired && this._has('tired') ? 'tired' : 'run';
        let speed = 1;
        let fps = 1;
        if (this._flee) {
            speed = 2.6;
            fps = 1.8;
        } else if (tired) {
            speed = 0.45;
            fps = 0.6;
        }
        const frame = this._move(ctx, speed, fps);
        const edge = this._edge(ctx);
        if (edge) {
            if (this._perch && !this._flee && chance(0.5)) {
                // Jump down off the window.
                this._jump(this._facing * 250 * this._scale, -350 * this._scale);
                return [sheet, frame, this._facing < 0];
            }
            this._facing = -edge;
        }

        if (ctx.hovered && !this._flee && !this._sulky) {
            this._wave();
        } else if (this._time > this._until) {
            const fled = this._flee;
            this._flee = false;
            if (this._sulky && fled)
                this._sulk();
            else if (fled)
                this._stand(1);
            else
                this._next(ctx.work, ctx.panelBottom);
        }
        return [sheet, frame, this._facing < 0];
    }

    _tick_chase(ctx) {
        const dx = this._ptr.x - this._x;
        this._facing = dx >= 0 ? 1 : -1;
        const frame = this._move(ctx, 1.5, 1.3);
        this._edge(ctx);
        if (Math.abs(dx) < 15 * this._scale || ctx.hovered)
            this._wave();
        else if (this._time > this._until)
            this._stand(1.5);
        return ['run', frame, this._facing < 0];
    }

    _tick_greet(ctx) {
        const target = ctx.work.x + ctx.work.width * 0.15;
        this._facing = 1;
        const frame = this._move(ctx, 1.2);
        if (this._x >= target) {
            this._wave();
            this._say(greetingText(null, this._settings.get_string('greeting-name')), true);
        }
        return ['run', frame];
    }

    // Panels and docks along the bottom edge (he'd be hidden behind them).
    _bottomChrome(ground) {
        // Docks often sit in a transparent full-width box: use the visible
        // dash background inside when there is one.
        const dashOf = actor => {
            if (actor.has_style_class_name?.('dash-background') && actor.visible)
                return actor;
            for (const child of actor.get_children()) {
                const found = dashOf(child);
                if (found)
                    return found;
            }
            return null;
        };
        return Main.layoutManager._trackedActors
            .map(t => t.actor)
            .filter(a => a?.visible && a.get_parent() && a !== Main.layoutManager.panelBox)
            .map(a => dashOf(a) ?? a)
            .map(a => {
                const [x, y] = a.get_transformed_position();
                const [w, h] = a.get_transformed_size();
                return {x1: x, x2: x + w, y1: y, y2: y + h};
            })
            .filter(r => r.y2 >= ground - 4 && r.y1 < ground && r.x2 > r.x1);
    }

    _tick_notify(ctx) {
        const monitor = Main.layoutManager.primaryMonitor;
        let target = monitor.x + monitor.width / 2;
        // Stand next to the dock, not behind it.
        if (!this._perch) {
            const half = this._cellWidth('front');
            for (const r of this._bottomChrome(ctx.surface.y)) {
                if (target > r.x1 - half && target < r.x2 + half)
                    target = this._x < (r.x1 + r.x2) / 2 ? r.x1 - half : r.x2 + half;
            }
        }
        target = Math.clamp(target, ctx.surface.x1 + 40, ctx.surface.x2 - 40);
        const dx = target - this._x;
        this._facing = dx >= 0 ? 1 : -1;
        const frame = this._move(ctx, 1.7, 1.4);
        this._edge(ctx);
        if (Math.abs(dx) < 20 * this._scale || this._time > this._until) {
            this._set('point', 2.2);
            if (chance(0.4))
                this._say(SAY.notification());
        }
        return ['run', frame, this._facing < 0];
    }

    _tick_point(ctx) {
        this._y = ctx.surface.y;
        if (this._time < 0.35)
            this._bounce = Math.sin(this._time / 0.35 * Math.PI) * 25 * this._scale;
        if (this._time > this._until)
            this._stand(1);
        if (this._has('moods'))
            return ['moods', 4 + Math.floor(this._time * 4) % 2];
        return ['front', WAVE[Math.floor(this._time * WAVE_FPS) % WAVE.length]];
    }

    _tick_stand(ctx) {
        this._y = ctx.surface.y;
        const blinking = this._time >= this._blinkAt && this._time < this._blinkAt + 0.15;
        if (this._time > this._until) {
            if (ctx.hovered) {
                this._stand(random(1, 2)); // keep looking at you
            } else if (!this._waved) {
                this._wave();
            } else {
                this._waved = false;
                this._run(chance(0.5) ? 1 : -1);
            }
        }
        return ['front', blinking ? BLINK : STAND];
    }

    _tick_wave(ctx) {
        this._y = ctx.surface.y;
        if (this._time > this._until) {
            this._waved = true;
            this._stand(random(0.8, 1.6));
            return ['front', STAND];
        }
        return ['front', WAVE[Math.min(Math.floor(this._time * WAVE_FPS), WAVE.length - 1)]];
    }

    _tick_dance(ctx) {
        this._y = ctx.surface.y;
        if (this._time > this._until || !this._env.music)
            this._run(chance(0.5) ? 1 : -1);
        if (this._has('dance'))
            return ['dance', Math.floor(this._time * 8) % FRAMES];
        // No dance poses: bob to the beat and sway.
        const beat = this._time * Math.PI * 2.2;
        this._bounce = Math.abs(Math.sin(beat)) * 10 * this._scale;
        return ['front', STAND, false, Math.sin(beat / 2) * 7];
    }

    _tick_fan(ctx) {
        this._y = ctx.surface.y;
        if (this._time > this._until)
            this._run(chance(0.5) ? 1 : -1);
        if (this._has('moods'))
            return ['moods', Math.floor(this._time * 5) % 2];
        if (!this._sweated) {
            this._sweated = true;
            this._showLabel('💦', null, this._x + 14 * this._scale, this._y - this._actor.height);
        }
        return ['front', STAND];
    }

    _tick_laugh(ctx) {
        this._y = ctx.surface.y;
        if (this._time > this._until) {
            this._waved = true;
            this._stand(1);
        }
        if (this._has('moods'))
            return ['moods', 2 + Math.floor(this._time * 8) % 2];
        this._bounce = Math.abs(Math.sin(this._time * Math.PI * 5)) * 6 * this._scale;
        return ['front', BLINK];
    }

    _seatY(ctx) {
        return ctx.surface.y + (1 - this._sheets.sit.seat) * this._sheetHeight('sit');
    }

    _tick_sit(ctx) {
        this._y = this._seatY(ctx);
        if (this._time > this._until || (ctx.hovered && this._time > 2)) {
            this._y = ctx.surface.y;
            this._stand(1);
            return ['front', STAND];
        }
        return ['sit', Math.floor(this._time * 3) % 4];
    }

    _tick_sleep(ctx) {
        const t = this._time;
        const sitting = this._perch && this._has('sit');
        // 💤 floating up from his head now and then.
        if (t - this._zzz > 1.4 && t > 1.5 && !this._isHidden()) {
            this._zzz = t;
            const h = this._actor.height;
            const hx = sitting ? this._x : this._x + this._sleepDir * h * 0.8;
            const hy = sitting ? this._y - h : this._y - 40 * this._scale;
            this._floatLabel('💤', hx, hy);
        }
        if (sitting) {
            this._y = this._seatY(ctx);
            return ['sit', t < 1 ? 4 : t < 2 ? 5 : t < 3 ? 6 : 7];
        }
        this._y = ctx.surface.y;
        // Yawn standing, then lie down.
        return ['front', BLINK, false, t < 0.8 ? 0 : this._sleepDir * 90];
    }

    _tick_waking(ctx) {
        this._y = ctx.surface.y;
        this._bounce = Math.sin(Math.min(this._time / 0.4, 1) * Math.PI) * 20 * this._scale;
        if (this._time > this._until)
            this._stand(1);
        return ['front', STAND];
    }

    _tick_hurt(ctx) {
        // Winces right after a hit, then runs away.
        this._y = ctx.surface.y;
        if (this._time > this._until)
            this._runAway();
        return ['front', now() - (this._hits.at(-1) ?? 0) < 0.25 ? BLINK : STAND];
    }

    _tick_ko(ctx) {
        this._y = ctx.surface.y;
        if (this._time > this._until + 0.7) {
            this._clearLabel('stars');
            this._runAway();
        }
        return ['front', BLINK, false, this._time < this._until ? this._koDir * 90 : 0];
    }

    _tick_sulk(ctx) {
        this._y = ctx.surface.y;
        if (this._time > this._until) {
            this._sulky = false;
            this._abuse = [];
            this._run(chance(0.5) ? 1 : -1);
        }
        if (this._has('moods'))
            return ['moods', 6 + Math.floor(this._time * 0.8) % 2];
        // No back pose: stand side-on, turned away from the cursor.
        return ['run', 0, this._ptr.x > this._x];
    }

    _tick_goto(ctx) {
        const prank = this._prank;
        const r = prank?.win.get_frame_rect();
        if (!r || r.x !== prank.rect.x || r.y !== prank.rect.y || this._time > this._until) {
            this._prank = null;
            this._run(chance(0.5) ? 1 : -1);
            return ['run', 0, this._facing < 0];
        }
        const dx = prank.x - this._x;
        this._facing = dx >= 0 ? 1 : -1;
        const frame = this._move(ctx, 1.2);
        if (Math.abs(dx) < 6 * this._scale) {
            this._x = prank.x;
            this._facing = -prank.side; // face the window
            this._pulled = 0;
            this._set('pull', 1.6);
        }
        return ['run', frame, this._facing < 0];
    }

    _tick_pull(ctx) {
        const prank = this._prank;
        this._y = ctx.surface.y;
        // Walk backwards, dragging the window along.
        const step = -this._facing * 45 * this._scale * ctx.dt;
        this._x += step;
        this._pulled += step;
        const win = prank?.win;
        if (win && !win.is_maximized()) {
            const r = win.get_frame_rect();
            const x = Math.round(prank.rect.x + this._pulled);
            if (r.x !== x)
                win.move_frame(true, x, r.y);
        }
        if (!win || this._time > this._until || this._edge(ctx)) {
            this._prank = null;
            if (chance(0.3))
                this._say(SAY.prank());
            this._run(-this._facing, true, 1.2);
        }
        if (this._has('hang'))
            return ['hang', 4 + Math.floor(this._time * 6) % 4, this._facing < 0];
        // No pulling poses: moonwalk (the running cycle backwards).
        return ['run', FRAMES - 1 - Math.floor(this._time * 8) % FRAMES, this._facing < 0];
    }

    _tick_held(ctx) {
        const p = this._ptr;
        // Keep the grab point under the pointer.
        const {width: w, height: h} = this._actor;
        const [pivX, pivY] = this._pivot;
        this._x = p.x + (0.5 - pivX) * w;
        this._y = Math.min(p.y + (1 - pivY) * h, ctx.work.y + ctx.work.height);
        // The body lags behind the hand.
        return ['front', STAND, false, Math.clamp(p.vx / this._scale * 0.035, -50, 50)];
    }

    _tick_fall(ctx) {
        const {dt, work, panelBottom} = ctx;
        const s = this._scale;
        const prevY = this._y;
        this._vy += GRAVITY * s * dt;
        this._x += this._vx * dt;
        this._y += this._vy * dt;
        const target = Math.clamp(this._vx / s * 0.02, -30, 30);
        const half = this._actor.width / 2;
        if (this._x < work.x + half || this._x > work.x + work.width - half) {
            this._x = Math.clamp(this._x, work.x + half, work.x + work.width - half);
            this._vx = -this._vx * 0.5;
        }

        // Thrown up to the top bar: grab onto it.
        const h = this._sheetHeight('front');
        if (this._onTop && !this._jumping && this._vy < 0 && this._y - h <= panelBottom) {
            this._y = panelBottom + h;
            this._angVel += this._vx / s * 0.1;
            this._setPivot(0.5, 0.02);
            this._set('hang', random(2.5, 4));
            return ['front', STAND];
        }

        // Landing: on a window top or on the ground.
        const ground = work.y + work.height;
        let landed = false;
        if (this._vy > 0) {
            const win = this._landingWindow(prevY, this._y, this._x, panelBottom);
            if (win) {
                this._y = win.get_frame_rect().y;
                this._perchOn(win);
                landed = true;
            } else if (this._y >= ground) {
                this._y = ground;
                landed = true;
            }
        }
        if (landed)
            this._land();

        if (this._jumping && this._state === 'fall' && Math.abs(this._vx) > 1)
            return ['run', 3, this._vx < 0, target];
        return ['front', STAND, false, target];
    }

    _land() {
        const speed = this._vy / this._scale;
        this._setPivot(0.5, 1);
        if (speed > HARD_LANDING) {
            this._jumping = false;
            this._knockOut(this._vx >= 0 ? 1 : -1, 2);
            if (chance(0.5))
                this._say(SAY.dropped());
        } else if (speed > BOUNCE_SPEED && !this._jumping) {
            // Bounce a little.
            this._vy = -this._vy * 0.35;
            this._vx *= 0.6;
            this._y -= 1;
            return;
        } else {
            this._jumping = false;
            this._waved = true;
            if (this._perch && this._has('sit') && chance(0.5))
                this._set('sit', random(10, 25));
            else
                this._stand(random(0.8, 1.4));
        }
        // Back under the windows (or right above the one he landed on).
        this._setOnTop(false);
        this._squash();
    }

    _tick_hang(ctx) {
        const h = this._has('hang') ? this._sheetHeight('hang') : this._sheetHeight('front');
        this._y = ctx.panelBottom + h;
        if (this._time > this._until) {
            this._vx = 0;
            this._vy = 0;
            this._set('fall');
        }
        if (this._has('hang'))
            return ['hang', Math.floor(this._time * 3) % 4];
        return ['front', STAND];
    }

    // Damped spring for the tilt; lying down stops at 90°.
    _swing(target, dt) {
        const acc = SWING_STIFFNESS * (target - this._angle) - SWING_DAMPING * this._angVel;
        this._angVel += acc * dt;
        this._angle += this._angVel * dt;
        if (Math.abs(this._angle) > 90) {
            this._angle = Math.sign(this._angle) * 90;
            this._angVel = -this._angVel * 0.3;
        }
        if (target === 0 && Math.abs(this._angle) < 0.05 && Math.abs(this._angVel) < 0.5)
            this._angle = this._angVel = 0;
        this._actor.rotation_angle_z = this._angle;
    }

    _squash() {
        this._actor.remove_transition('scale-y');
        this._actor.ease({
            scale_y: 0.82,
            duration: 70,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._actor?.ease({
                scale_y: 1,
                duration: 320,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            }),
        });
    }

    _flashRed() {
        this._flash.set_brightness_full(0.35, -0.15, -0.15);
        this._flash.enabled = true;
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._flashId = 0;
            if (this._flash)
                this._flash.enabled = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    // -- drawing -----------------------------------------------------------------

    _cellWidth(name) {
        const sheet = this._sheets[name] ?? this._sheets.front;
        return Math.round(sheet.width / FRAMES * SHEET_SCALE * this._scale);
    }

    _sheetHeight(name) {
        const sheet = this._sheets[name] ?? this._sheets.front;
        return Math.round(sheet.height * SHEET_SCALE * this._scale);
    }

    _show(name, frame, mirror = false) {
        const sheet = this._sheets[name] ?? this._sheets.front;
        const cellW = this._cellWidth(name);
        const h = this._sheetHeight(name);
        if (this._shown !== sheet) {
            for (const s of Object.values(this._sheets))
                s.widget.visible = s === sheet;
            sheet.widget.set_size(cellW * FRAMES, h);
            this._actor.set_size(cellW, h);
            this._shown = sheet;
        }
        sheet.widget.set_position(-frame * cellW, 0);
        this._actor.scale_x = mirror ? -1 : 1;
    }

    _setPivot(x, y) {
        this._pivot = [x, y];
        this._actor.set_pivot_point(x, y);
    }

    _place() {
        const {width: w, height: h} = this._actor;
        if (!this._pivot)
            this._setPivot(0.5, 1);
        this._actor.set_position(Math.round(this._x - w / 2), Math.round(this._y - h));
        this._actor.translation_y = -Math.round(this._bounce);

        if (!this._labels.size)
            return;
        // Stars and the speech bubble follow his head, tilt included.
        const rad = this._angle * Math.PI / 180;
        const hx = this._x + Math.sin(rad) * h * 0.85;
        const hy = this._y - Math.cos(rad) * h * 0.85 - this._bounce;
        const hidden = this._isHidden();
        const monitor = Main.layoutManager.primaryMonitor;
        for (const label of this._labels) {
            if (label._follow === 'stars') {
                label.set_position(Math.round(hx - label.width / 2), Math.round(hy - label.height));
                label.visible = !hidden;
            } else if (label._follow === 'bubble') {
                const top = this._y - h - this._bounce;
                const x = Math.clamp(this._x - label.width / 2,
                    monitor.x + 8, monitor.x + monitor.width - label.width - 8);
                label.set_position(Math.round(x),
                    Math.round(Math.max(top - label.height - 6, monitor.y)));
                label.visible = !hidden || label._important;
            }
        }
    }

    // A speech bubble over his head. Important ones (reminders) show even
    // when he's behind a window.
    _say(text, important = false) {
        if (!this._labels || !this._settings.get_boolean('runner-speech'))
            return;
        if (!important && this._isHidden())
            return;
        this._clearLabel('bubble');
        const label = new St.Label({text, style_class: 'rsx-runner-bubble', reactive: false});
        label._follow = 'bubble';
        label._important = important;
        Main.layoutManager.uiGroup.add_child(label);
        this._labels.add(label);
        label.opacity = 0;
        label.ease({opacity: 255, duration: 150});
        const seconds = important ? 7 : Math.max(2.2, text.length * 0.08);
        this._later(seconds * 1000, () => {
            if (!this._labels?.has(label))
                return;
            label.ease({opacity: 0, duration: 250, onStopped: () => this._removeLabel(label)});
        });
    }

    // An emoji: following his head, or popping at a point.
    _showLabel(text, follow, x = 0, y = 0) {
        if (follow)
            this._clearLabel(follow);
        const label = new St.Label({text, style_class: 'rsx-runner-label', reactive: false});
        label._follow = follow;
        Main.layoutManager.uiGroup.add_child(label);
        this._labels.add(label);
        if (follow)
            return;
        const [, w] = label.get_preferred_width(-1);
        const [, h] = label.get_preferred_height(-1);
        label.set_position(Math.round(x - w / 2), Math.round(y - h / 2));
        label.set_pivot_point(0.5, 0.5);
        label.set({scale_x: 0.4, scale_y: 0.4});
        label.ease({
            scale_x: 1.3,
            scale_y: 1.3,
            translation_y: -20 * this._scale,
            duration: 500,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        label.ease({
            opacity: 0,
            delay: 250,
            duration: 250,
            onStopped: () => this._removeLabel(label),
        });
    }

    // An emoji that drifts up and fades (💤).
    _floatLabel(text, x, y) {
        const label = new St.Label({text, style_class: 'rsx-runner-label rsx-runner-small', reactive: false});
        Main.layoutManager.uiGroup.add_child(label);
        this._labels.add(label);
        label.set_position(Math.round(x), Math.round(y));
        label.ease({
            translation_x: 20 * this._scale,
            translation_y: -50 * this._scale,
            opacity: 0,
            duration: 2000,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => this._removeLabel(label),
        });
    }

    _clearLabel(follow) {
        for (const label of this._labels ?? []) {
            if (label._follow === follow)
                this._removeLabel(label);
        }
    }

    _removeLabel(label) {
        if (!this._labels?.delete(label))
            return;
        label.destroy();
    }

    disable() {
        this._enabled = false;
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        Main.overview.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources())
            source.disconnectObject(this);
        this._perch?.disconnectObject(this);
        this._perch = null;
        this._prank = null;
        this._mpris = null;
        this._upower = null;
        if (this._idleWatch)
            this._idle.remove_watch(this._idleWatch);
        if (this._activeWatch)
            this._idle.remove_watch(this._activeWatch);
        this._idleWatch = this._activeWatch = 0;
        this._idle = null;
        if (this._reminderId)
            GLib.source_remove(this._reminderId);
        this._reminderId = 0;
        for (const id of this._timeouts ?? [])
            GLib.source_remove(id);
        this._timeouts = null;
        this._grab?.dismiss();
        this._grab = null;
        if (this._flashId)
            GLib.source_remove(this._flashId);
        this._flashId = 0;
        this._timeline?.stop();
        this._timeline = null;
        for (const label of this._labels ?? [])
            label.destroy();
        this._labels = null;
        this._actor?.destroy();
        this._actor = null;
        this._sheets = null;
        this._flash = null;
        this._shown = null;
        this._pivot = null;
    }
}
