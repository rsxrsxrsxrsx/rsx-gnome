// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dynamic island: one black pill at the top center that morphs between
// what's going on:
//
//   hidden    nothing to show; the normal top bar clock is visible
//   compact   music is playing or a timer runs: a small pill over the clock
//             (the clock stays readable inside it)
//   expanded  mouse over the compact pill: track, progress, controls, timer
//   picker    right click on the clock or the pill: start a timer
//   activity  for a few seconds: a new track, a notification, a system event
//             (caps lock, sound output, screen recording or sharing, charging)
//
// Notifications go here instead of GNOME's banners (critical ones still use
// the normal banner).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {MprisSource} from 'resource:///org/gnome/shell/ui/mpris.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {_} from './i18n.js';
import {activePlayer, artistsText, coverActor} from './media.js';

const MORPH_TIME = 460;
const FADE_TIME = 160;
const OUT_TIME = 90; // old view fading out
const SHRINK_TIME = 380;
const HIDE_TIME = 260;
const ACTIVITY_MS = 3000;
const NOTIFICATION_MS = 4500;
const SHORT_MS = 1600; // caps lock and the like
const TIMER_DONE_MS = 12000;
const EXPAND_DELAY = 120;
const COLLAPSE_DELAY = 450;
const PAUSE_KEEP_MS = 60 * 1000; // a paused player keeps the pill this long
const EXPANDED_WIDTH = 380; // logical px
const COMPACT_MAX_WIDTH = 280;
const ACTIVITY_MAX_WIDTH = 420;
const TIMER_PRESETS = [1, 3, 5, 10, 15, 25, 45]; // minutes
const EQ_BARS = 4;
const EQ_MS = 160;
const STARTUP_QUIET_MS = 3000; // no system events right after login

const sf = () => St.ThemeContext.get_for_stage(global.stage).scaleFactor;
const now = () => GLib.get_monotonic_time() / 1000; // ms

function label(text, styleClass, params = {}) {
    const l = new St.Label({
        text: text ?? '',
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
        ...params,
    });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return l;
}

function vbox(styleClass, params = {}) {
    return new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: styleClass,
        ...params,
    });
}

function iconButton(iconName, styleClass, onClick) {
    const button = new St.Button({
        style_class: `rsx-island-button ${styleClass}`,
        child: new St.Icon({icon_name: iconName}),
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

// 1:05 or 1:02:03
function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor(total / 60) % 60;
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// MPRIS durations are in microseconds; some players send nothing.
function trackLength(player) {
    try {
        const v = player?._playerProxy?.Metadata?.['mpris:length']?.deepUnpack();
        return v > 0 ? Number(v) / 1000 : 0;
    } catch {
        return 0;
    }
}

export class DynamicIsland {
    enable() {
        this._activities = [];
        this._activity = null;
        this._activityId = 0;
        this._expanded = false;
        this._picker = false;
        this._viewKey = null;
        this._content = null;
        this._live = null;
        this._timer = null;
        this._pausedAt = new Map(); // player -> ms when it was paused
        this._startedAt = now();

        this._pill = new St.Widget({
            style_class: 'rsx-island',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            visible: false,
        });
        Main.layoutManager.uiGroup.add_child(this._pill);
        this._pill.connectObject(
            'notify::width', () => this._syncShape(),
            'notify::hover', () => this._onHover(),
            'button-release-event', (_a, event) => this._onClick(event),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._syncShape(), this);
        global.display.connectObject('in-fullscreen-changed', () => this._update(), this);
        Main.sessionMode.connectObject('updated', () => this._update(), this);

        this._watchClock();
        this._watchMedia();
        this._watchNotifications();
        this._watchSystem();
        this._update();
    }

    // -- what to show ---------------------------------------------------------

    // The player that keeps the pill: playing, or paused a moment ago.
    _player() {
        const player = activePlayer(this._mpris);
        if (!player)
            return null;
        if (player.status === 'Playing')
            return player;
        const pausedAt = this._pausedAt.get(player);
        if (player.status === 'Paused' && pausedAt && now() - pausedAt < PAUSE_KEEP_MS)
            return player;
        return null;
    }

    _blocked() {
        if (Main.sessionMode.isLocked || Main.sessionMode.isGreeter)
            return true;
        // Fullscreen video or games: only a finished timer gets through.
        return !!Main.layoutManager.primaryMonitor?.inFullscreen &&
            this._activity?.kind !== 'timer-done';
    }

    _desired() {
        if (this._blocked())
            return null;
        if (this._activity)
            return {key: `activity:${this._activity.id}`, build: () => this._buildActivity(this._activity)};
        if (this._picker)
            return {key: 'picker', build: () => this._buildPicker()};

        const player = this._player();
        const timer = this._timer;
        if (!player && !timer)
            return null;
        const music = player ? `${player._busName}|${player.trackTitle}|${player.trackCoverUrl}` : '';
        const timerKind = timer?.kind ?? '';
        if (this._expanded) {
            return {
                key: `expanded:${music}:${timerKind}`,
                build: () => this._buildExpanded(player, timer),
            };
        }
        return {
            key: `compact:${music}:${timerKind}:${this._clockUnder()}`,
            build: () => this._buildCompact(player, timer),
        };
    }

    _update() {
        if (!this._pill)
            return;
        const desired = this._desired();
        if (desired?.key === this._viewKey) {
            this._refresh();
            return;
        }
        this._viewKey = desired?.key ?? null;
        this._live = {clocks: [], timers: [], playIcons: [], eqs: [], progress: null, player: null};
        this._morph(desired?.build() ?? null);
        this._refresh();
    }

    // Updates the parts of the current view that change by themselves.
    _refresh() {
        const live = this._live;
        if (!live)
            return;
        const clock = this._clockText();
        live.clocks.forEach(l => (l.text = clock));

        const timer = this._timer;
        const timerText = timer ? formatTime(this._timerValue()) : '';
        live.timers.forEach(l => (l.text = timerText));
        live.timerPause?.child.set({
            icon_name: timer?.paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic',
        });

        const playing = live.player?.status === 'Playing';
        live.playIcons.forEach(i => (i.icon_name =
            playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic'));
        this._syncEq(live.eqs.length > 0 && playing);
        this._syncProgress(live.progress && live.player ? live.player : null);
        this._syncTimerTick();
    }

    // -- morphing -------------------------------------------------------------

    _compactHeight() {
        const panel = Main.panel?.height ?? 0;
        return Math.max(Math.round(panel - 6 * sf()), Math.round(22 * sf()));
    }

    _morph(content) {
        const pill = this._pill;
        const old = this._content;
        this._content = content;

        // The old view goes almost at once, so it never shows squeezed
        // inside a shrinking pill.
        if (old) {
            old.remove_all_transitions();
            old.ease({
                opacity: 0,
                duration: OUT_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => old.destroy(),
            });
        }

        if (!content) {
            const h = this._compactHeight();
            pill.ease({
                width: Math.max(h, Math.round(pill.width * 0.5)),
                height: h,
                opacity: 0,
                duration: HIDE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: finished => {
                    if (finished && !this._content)
                        pill.hide();
                },
            });
            return;
        }

        // Measure at the final size, then keep that size while the pill
        // grows or shrinks around it, so the text doesn't reflow.
        content.set({opacity: 0, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        pill.add_child(content);
        // (Measured only now: text has no font size until it's on the stage.)
        const natural = content.get_preferred_width(content._rsxHeight ?? -1)[1];
        const width = content._rsxWidth ??
            Math.min(Math.max(natural, content._rsxMinWidth ?? 0), content._rsxMaxWidth ?? Infinity);
        const height = content._rsxHeight ?? content.get_preferred_height(width)[1];
        content.set_size(width, height);

        const appearing = !pill.visible || !old;
        if (!pill.visible) {
            const h = this._compactHeight();
            pill.set({visible: true, opacity: 0, width: h * 2, height: h});
            pill.y = (Main.layoutManager.primaryMonitor?.y ?? 0) + Math.round((Main.panel.height - h) / 2);
            this._syncShape();
        }
        pill.get_parent().set_child_above_sibling(pill, null);
        pill.ease({opacity: 255, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        // One soft, quick-start curve for growing and shrinking alike.
        const ease = (prop, to) => {
            const grow = to >= pill[prop];
            pill.ease_property(prop, to, {
                duration: grow ? MORPH_TIME : SHRINK_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
        };
        const shrinking = height < pill.height;
        ease('width', width);
        ease('height', height);

        content.ease({
            opacity: 255,
            delay: appearing ? 80 : shrinking ? 130 : OUT_TIME,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // Centered. (The corner radius is fixed in CSS; St shrinks it to fit
    // short pills, so it never needs restyling while morphing.)
    _syncShape() {
        const pill = this._pill;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!pill || !monitor)
            return;
        pill.x = Math.round(monitor.x + (monitor.width - pill.width) / 2);
    }

    // -- views ----------------------------------------------------------------

    // Is the top bar clock still in the middle, under the pill?
    _clockUnder() {
        const container = Main.panel.statusArea.dateMenu?.container;
        return !!container && container.get_parent() === Main.panel._centerBox;
    }

    // [cover or timer icon]  track title  [eq or timer]. If the clock is
    // still in the middle of the top bar, the pill covers it and shows the
    // time instead of the title.
    _buildCompact(player, timer) {
        const s = sf();
        const h = this._compactHeight();
        const clockUnder = this._clockUnder();
        const box = new St.BoxLayout({style_class: 'rsx-island-compact'});

        if (player)
            this._live.player = player;
        const lead = player
            ? this._cover(player, 18, 5)
            : new St.Icon({icon_name: 'alarm-symbolic', style_class: 'rsx-island-accent rsx-island-small-icon'});
        lead.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(lead);

        if (clockUnder) {
            const clock = label(this._clockText(), 'rsx-island-clock', {x_expand: true, x_align: Clutter.ActorAlign.CENTER});
            this._live.clocks.push(clock);
            box.add_child(clock);
        } else if (player) {
            box.add_child(label(player.trackTitle, 'rsx-island-compact-title', {x_expand: true}));
        }

        const tail = timer ? this._timerLabel('rsx-island-compact-timer') : this._eq(player);
        tail.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(tail);

        if (clockUnder) {
            // At least as wide as the panel clock, so it's covered completely.
            const clockWidth = Main.panel.statusArea.dateMenu.container.width;
            box._rsxMinWidth = clockWidth + 10 * s;
        }
        box._rsxMaxWidth = COMPACT_MAX_WIDTH * s;
        box._rsxHeight = h;
        return box;
    }

    _buildExpanded(player, timer) {
        const s = sf();
        const box = vbox('rsx-island-expanded');
        box._rsxWidth = EXPANDED_WIDTH * s;

        if (player) {
            this._live.player = player;
            const head = new St.BoxLayout({style_class: 'rsx-island-head'});
            head.add_child(this._cover(player, 52, 12));
            const text = vbox('rsx-island-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            text.add_child(label(player.trackTitle, 'rsx-island-title'));
            const artists = artistsText(player);
            if (artists)
                text.add_child(label(artists, 'rsx-island-subtitle'));
            head.add_child(text);
            head.add_child(this._eq(player));
            box.add_child(head);

            if (trackLength(player)) {
                const row = new St.BoxLayout({style_class: 'rsx-island-progress'});
                const elapsed = label('0:00', 'rsx-island-time');
                // A taller invisible strip around the thin bar, to grab it.
                const seek = new St.Widget({
                    style_class: 'rsx-island-seek',
                    layout_manager: new Clutter.BinLayout(),
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    reactive: this._canSeek(player),
                    track_hover: true,
                });
                const track = new St.Widget({style_class: 'rsx-island-track', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
                const fill = new St.Widget({style_class: 'rsx-island-fill', width: 0});
                track.add_child(fill);
                track.connect('notify::height', () => (fill.height = track.height));
                seek.add_child(track);
                const total = label(formatTime(trackLength(player)), 'rsx-island-time rsx-island-time-end');
                row.add_child(elapsed);
                row.add_child(seek);
                row.add_child(total);
                box.add_child(row);
                // Start where the track is now (last known position, moved
                // on by the time since), not at zero.
                const fraction = this._estimateFraction(player);
                elapsed.text = formatTime(fraction * trackLength(player));
                const progress = {elapsed, track, fill, total, fraction};
                // The bar has no width until it's laid out: place the fill then.
                track.connect('notify::width', () => {
                    fill.remove_all_transitions();
                    fill.width = Math.round(track.width * progress.fraction);
                });
                this._live.progress = progress;
                this._makeSeekable(seek, player, progress);
            }

            const controls = new St.BoxLayout({style_class: 'rsx-island-controls', x_align: Clutter.ActorAlign.CENTER});
            const prev = iconButton('media-skip-backward-symbolic', '', () => player.previous());
            const play = iconButton('media-playback-start-symbolic', 'rsx-island-play', () => player.playPause());
            const next = iconButton('media-skip-forward-symbolic', '', () => player.next());
            prev.reactive = player.canGoPrevious;
            next.reactive = player.canGoNext;
            this._live.playIcons.push(play.child);
            controls.add_child(prev);
            controls.add_child(play);
            controls.add_child(next);
            box.add_child(controls);
        }

        if (timer) {
            if (player)
                box.add_child(new St.Widget({style_class: 'rsx-island-separator', x_expand: true}));
            box.add_child(this._timerRow(timer));
        }
        return box;
    }

    _timerRow(timer) {
        const row = new St.BoxLayout({style_class: 'rsx-island-timer-row'});
        row.add_child(new St.Icon({
            icon_name: 'alarm-symbolic',
            style_class: 'rsx-island-accent rsx-island-timer-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const text = vbox('rsx-island-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(label(timer.kind === 'timer' ? _('Timer') : _('Stopwatch'), 'rsx-island-subtitle'));
        text.add_child(this._timerLabel('rsx-island-big-timer'));
        row.add_child(text);
        const pause = iconButton('media-playback-pause-symbolic', 'rsx-island-accent-button',
            () => this._toggleTimerPause());
        this._live.timerPause = pause;
        row.add_child(pause);
        row.add_child(iconButton('window-close-symbolic', '', () => this._stopTimer()));
        return row;
    }

    _buildPicker() {
        const s = sf();
        const box = vbox('rsx-island-expanded rsx-island-picker');
        box._rsxWidth = EXPANDED_WIDTH * s;

        const head = new St.BoxLayout({style_class: 'rsx-island-head'});
        head.add_child(new St.Icon({
            icon_name: 'alarm-symbolic',
            style_class: 'rsx-island-accent rsx-island-timer-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        head.add_child(label(_('Timer'), 'rsx-island-title', {x_expand: true}));
        box.add_child(head);

        const chip = (text, onClick) => {
            const button = new St.Button({
                style_class: 'rsx-island-chip',
                label: text,
                can_focus: true,
                x_expand: true,
            });
            button.connect('clicked', () => onClick());
            return button;
        };
        const rows = [TIMER_PRESETS.slice(0, 4), TIMER_PRESETS.slice(4)];
        rows.forEach((minutes, i) => {
            const row = new St.BoxLayout({style_class: 'rsx-island-chips'});
            for (const m of minutes)
                row.add_child(chip(_('%d min').replace('%d', m), () => this._startTimer(m * 60 * 1000)));
            if (i === rows.length - 1)
                row.add_child(chip(_('Stopwatch'), () => this._startStopwatch()));
            box.add_child(row);
        });
        return box;
    }

    _buildActivity(activity) {
        const s = sf();
        const box = new St.BoxLayout({style_class: `rsx-island-activity ${activity.styleClass ?? ''}`});
        let lead;
        if (activity.player) {
            lead = coverActor(activity.player.trackCoverUrl, 36, 9, 'rsx-island-cover');
        } else {
            lead = new St.Icon({
                gicon: activity.gicon ?? null,
                icon_name: activity.gicon ? null : activity.icon,
                style_class: `rsx-island-activity-icon ${activity.accent ? 'rsx-island-accent' : ''}`,
            });
        }
        lead.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(lead);

        const text = vbox('rsx-island-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(label(activity.title, 'rsx-island-title'));
        if (activity.subtitle)
            text.add_child(label(activity.subtitle, 'rsx-island-subtitle'));
        box.add_child(text);

        if (activity.player) {
            const eq = this._eq(activity.player);
            box.add_child(eq);
        }

        box._rsxMaxWidth = ACTIVITY_MAX_WIDTH * s;
        return box;
    }

    _cover(player, size, radius) {
        const button = new St.Button({
            child: coverActor(player.trackCoverUrl, size, radius, 'rsx-island-cover'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => {
            this._expanded = false;
            player.raise();
            this._update();
        });
        return button;
    }

    _timerLabel(styleClass) {
        const l = label(this._timer ? formatTime(this._timerValue()) : '', `rsx-island-accent ${styleClass}`);
        this._live.timers.push(l);
        return l;
    }

    // Little bars that jump while music plays.
    _eq(player) {
        const s = sf();
        const box = new St.BoxLayout({
            style_class: 'rsx-island-eq',
            height: 16 * s,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (let i = 0; i < EQ_BARS; i++) {
            box.add_child(new St.Widget({
                style_class: 'rsx-island-eq-bar',
                width: 3 * s,
                height: 3 * s,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        this._live.eqs.push(box);
        this._live.player ??= player;
        return box;
    }

    _syncEq(on) {
        if (on && !this._eqId) {
            this._eqId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EQ_MS, () => {
                const s = sf();
                for (const box of this._live?.eqs ?? []) {
                    for (const bar of box.get_children()) {
                        bar.ease({
                            height: Math.round((3 + Math.random() * 13) * s),
                            duration: EQ_MS,
                            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                        });
                    }
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._eqId) {
            GLib.source_remove(this._eqId);
            this._eqId = 0;
            for (const box of this._live?.eqs ?? []) {
                for (const bar of box.get_children())
                    bar.ease({height: 3 * sf(), duration: EQ_MS * 2});
            }
        }
    }

    // Ask the player where it is once a second; the bar slides in between.
    _syncProgress(player) {
        if (!player) {
            if (this._progressId)
                GLib.source_remove(this._progressId);
            this._progressId = 0;
            return;
        }
        if (this._progressId)
            return;
        const poll = () => {
            Gio.DBus.session.call(player._busName, '/org/mpris/MediaPlayer2',
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
                null, Gio.DBusCallFlags.NONE, 500, null, (conn, res) => {
                    let position;
                    try {
                        position = Number(conn.call_finish(res).recursiveUnpack()[0]) / 1000;
                    } catch {
                        return;
                    }
                    this._showProgress(player, position);
                });
            return GLib.SOURCE_CONTINUE;
        };
        poll();
        this._progressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, poll);
    }

    _canSeek(player) {
        try {
            return player._playerProxy?.get_cached_property('CanSeek')?.unpack() ?? true;
        } catch {
            return true;
        }
    }

    // Click or drag on the bar to jump in the track.
    _makeSeekable(seek, player, progress) {
        const fractionAt = event => {
            const [x] = event.get_coords();
            const [ok, lx] = progress.track.transform_stage_point(x, 0);
            const width = progress.track.width;
            return ok && width ? Math.min(Math.max(lx / width, 0), 1) : progress.fraction;
        };
        const show = fraction => {
            progress.fraction = fraction;
            progress.fill.remove_all_transitions();
            progress.fill.width = Math.round(progress.track.width * fraction);
            progress.elapsed.text = formatTime(fraction * trackLength(player));
        };
        let grab = null;
        seek.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            grab = global.stage.grab(seek);
            progress.dragging = true;
            show(fractionAt(event));
            return Clutter.EVENT_STOP;
        });
        seek.connect('motion-event', (_a, event) => {
            if (progress.dragging)
                show(fractionAt(event));
            return Clutter.EVENT_STOP;
        });
        seek.connect('button-release-event', (_a, event) => {
            if (!progress.dragging)
                return Clutter.EVENT_PROPAGATE;
            show(fractionAt(event));
            progress.dragging = false;
            progress.seekedAt = now();
            grab?.dismiss();
            grab = null;
            this._seek(player, progress.fraction * trackLength(player));
            // The pointer may have left the pill while dragging.
            if (!this._pill.hover)
                this._onHover();
            return Clutter.EVENT_STOP;
        });
        seek.connect('destroy', () => grab?.dismiss());
    }

    _seek(player, ms) {
        let trackId = null;
        try {
            trackId = player._playerProxy?.Metadata?.['mpris:trackid']?.deepUnpack() ?? null;
        } catch {}
        const iface = 'org.mpris.MediaPlayer2.Player';
        const call = (method, args) => Gio.DBus.session.call(player._busName, '/org/mpris/MediaPlayer2',
            iface, method, args, null, Gio.DBusCallFlags.NONE, 1000, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch {
                    // No SetPosition for this track: jump by the difference.
                    if (method === 'SetPosition')
                        call('Seek', new GLib.Variant('(x)', [Math.round((ms - this._positionNow(player)) * 1000)]));
                }
            });
        if (trackId)
            call('SetPosition', new GLib.Variant('(ox)', [trackId, Math.round(ms * 1000)]));
        else
            call('Seek', new GLib.Variant('(x)', [Math.round((ms - this._positionNow(player)) * 1000)]));
        this._lastPosition = {player, position: ms, at: now()};
    }

    // Best guess of where the player is right now, in ms.
    _positionNow(player) {
        return this._estimateFraction(player) * trackLength(player);
    }

    _estimateFraction(player) {
        const length = trackLength(player);
        const last = this._lastPosition;
        if (!length || last?.player !== player)
            return 0;
        const moved = player.status === 'Playing' ? now() - last.at : 0;
        return Math.min(Math.max((last.position + moved) / length, 0), 1);
    }

    _showProgress(player, position) {
        const progress = this._live?.progress;
        const length = trackLength(player);
        if (!progress || this._live.player !== player || !length || progress.dragging)
            return;
        // Right after a seek the player may still report the old place.
        if (progress.seekedAt && now() - progress.seekedAt < 800)
            return;
        this._lastPosition = {player, position, at: now()};
        const fraction = Math.min(Math.max(position / length, 0), 1);
        progress.elapsed.text = formatTime(position);
        if (!progress.track.width) {
            progress.fraction = fraction; // placed once the bar has a width
            return;
        }
        const width = Math.round(progress.track.width * fraction);
        // Slide smoothly while playing; jump on seeks and track starts.
        const smooth = player.status === 'Playing' && Math.abs(fraction - progress.fraction) * length < 2500;
        progress.fill.ease({
            width,
            duration: smooth ? 1000 : 0,
            mode: Clutter.AnimationMode.LINEAR,
        });
        progress.fraction = fraction;
    }

    // -- events ---------------------------------------------------------------

    _onHover() {
        this._clearHoverTimeout();
        const hover = this._pill.hover;
        if (hover && !this._expanded && !this._activity && !this._picker && this._viewKey?.startsWith('compact')) {
            this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EXPAND_DELAY, () => {
                this._hoverId = 0;
                if (this._pill.hover && !this._dateMenuOpen()) {
                    this._expanded = true;
                    this._update();
                }
                return GLib.SOURCE_REMOVE;
            });
        } else if (!hover && (this._expanded || this._picker)) {
            this._hoverId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COLLAPSE_DELAY, () => {
                this._hoverId = 0;
                if (!this._pill.hover && !this._live?.progress?.dragging) {
                    this._expanded = false;
                    this._picker = false;
                    this._update();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _clearHoverTimeout() {
        if (this._hoverId)
            GLib.source_remove(this._hoverId);
        this._hoverId = 0;
    }

    _onClick(event) {
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            this._togglePicker();
            return Clutter.EVENT_STOP;
        }
        // Buttons inside the pill handle their own clicks.
        for (let a = global.stage.get_event_actor(event); a && a !== this._pill; a = a.get_parent()) {
            if (a instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
        }
        if (this._activity) {
            this._activity.onClick?.();
            this._endActivity();
            return Clutter.EVENT_STOP;
        }
        if (this._picker)
            return Clutter.EVENT_STOP;
        this._expanded = false;
        if (this._clockUnder()) {
            // The pill sits over the clock: a click opens the calendar as usual.
            Main.panel.statusArea.dateMenu?.menu.toggle();
        } else {
            this._live?.player?.raise();
        }
        this._update();
        return Clutter.EVENT_STOP;
    }

    _dateMenuOpen() {
        return !!Main.panel.statusArea.dateMenu?.menu.isOpen;
    }

    // -- clock ----------------------------------------------------------------

    _watchClock() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu = dateMenu;
        dateMenu?._clockDisplay?.connectObject('notify::text', () => this._refresh(), this);
        // The clock may move to the right of the top bar (or back).
        dateMenu?.container.connectObject('parent-set', () => this._update(), this);
        // Right click on the clock: timer picker.
        dateMenu?.connectObject('captured-event', (_a, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS &&
                event.get_button() === Clutter.BUTTON_SECONDARY) {
                this._togglePicker();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }, this);
        dateMenu?.menu.connectObject('open-state-changed', (_m, open) => {
            if (open && (this._expanded || this._picker)) {
                this._expanded = this._picker = false;
                this._update();
            }
        }, this);
    }

    _clockText() {
        return this._dateMenu?._clockDisplay?.text ??
            GLib.DateTime.new_now_local().format('%H:%M');
    }

    // -- media ----------------------------------------------------------------

    _watchMedia() {
        this._mpris = new MprisSource();
        this._seen = new Map(); // player -> "title|status"
        const track = player => {
            this._seen.set(player, `${player.trackTitle}|${player.status}`);
            player.connectObject('changed', () => this._onPlayerChanged(player), this);
        };
        this._mpris.connectObject(
            'player-added', (_s, player) => {
                track(player);
                this._update();
            },
            'player-removed', (_s, player) => {
                player.disconnectObject(this);
                this._seen.delete(player);
                this._pausedAt.delete(player);
                this._update();
            }, this);
        this._mpris.players?.forEach(track);
    }

    _onPlayerChanged(player) {
        const key = `${player.trackTitle}|${player.status}`;
        const [oldTitle, oldStatus] = (this._seen.get(player) ?? '|').split('|');
        this._seen.set(player, key);

        if (player.status === 'Paused' && oldStatus === 'Playing') {
            this._pausedAt.set(player, now());
            // Drop the pill once the pause has lasted long enough.
            if (this._pauseId)
                GLib.source_remove(this._pauseId);
            this._pauseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAUSE_KEEP_MS + 100, () => {
                this._pauseId = 0;
                this._update();
                return GLib.SOURCE_REMOVE;
            });
        } else if (player.status === 'Playing') {
            this._pausedAt.delete(player);
        }

        // A new track, or music starts: show it for a moment, unless the
        // expanded view already shows it.
        const startedOrChanged = player.status === 'Playing' &&
            (player.trackTitle !== oldTitle || oldStatus !== 'Playing');
        if (startedOrChanged && activePlayer(this._mpris) === player && !this._expanded) {
            this._pushActivity({
                kind: 'media',
                player,
                title: player.trackTitle,
                subtitle: artistsText(player),
                timeout: ACTIVITY_MS,
                onClick: () => player.raise(),
            });
        }
        this._update();
    }

    // -- notifications --------------------------------------------------------

    _watchNotifications() {
        const tray = Main.messageTray;
        this._tray = tray;
        const origShow = tray._showNotification;
        const self = this;
        // GNOME is about to show a banner: show it in the island instead.
        tray._showNotification = function () {
            const notification = this._notificationQueue[0];
            if (!notification || notification.urgency === Urgency.CRITICAL || self._blocked())
                return origShow.call(this);
            this._notificationQueue.shift();
            this.emit('queue-changed');
            const gicon = notification.gicon ?? notification.source?.icon ?? null;
            self._pushActivity({
                kind: 'notification',
                gicon,
                icon: 'preferences-system-notifications-symbolic',
                title: notification.title || notification.source?.title,
                subtitle: (notification.body ?? '').split('\n')[0],
                timeout: NOTIFICATION_MS,
                onClick: () => notification.activate(),
            });
            // Let GNOME look at the rest of the queue after this call.
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                tray._updateState();
                return GLib.SOURCE_REMOVE;
            });
            return undefined;
        };
    }

    // -- system events --------------------------------------------------------

    _watchSystem() {
        const quiet = () => now() - this._startedAt < STARTUP_QUIET_MS;

        // Caps Lock
        const keymap = Clutter.get_default_backend().get_default_seat().get_keymap();
        this._keymap = keymap;
        this._caps = keymap.get_caps_lock_state();
        keymap.connectObject('state-changed', () => {
            const caps = keymap.get_caps_lock_state();
            if (caps === this._caps)
                return;
            this._caps = caps;
            this._pushActivity({
                kind: 'caps',
                icon: 'input-keyboard-symbolic',
                accent: caps,
                title: caps ? _('Caps Lock is on') : _('Caps Lock is off'),
                timeout: SHORT_MS,
            });
        }, this);

        // Sound output: headphones, speakers, Bluetooth
        this._mixer = getMixerControl();
        this._mixer.connectObject('active-output-update', (control, id) => {
            if (id === this._outputId)
                return;
            const first = this._outputId === undefined;
            this._outputId = id;
            const device = control.lookup_output_id(id);
            if (first || quiet() || !device)
                return;
            this._pushActivity({
                kind: 'output',
                icon: device.get_icon_name() || 'audio-headphones-symbolic',
                title: device.get_description(),
                subtitle: device.get_origin() || _('Sound output'),
                timeout: ACTIVITY_MS,
            });
        }, this);

        // Screen recording (GNOME's own recorder)
        Main.screenshotUI?.connectObject('notify::screencast-in-progress', () => {
            const on = Main.screenshotUI.screencast_in_progress;
            this._pushActivity({
                kind: 'recording',
                icon: 'media-record-symbolic',
                styleClass: on ? 'rsx-island-red' : '',
                title: on ? _('Screen recording started') : _('Screen recording saved'),
                timeout: ACTIVITY_MS,
            });
        }, this);

        // Screen sharing
        const sharing = Main.panel.statusArea.screenSharing;
        this._sharing = sharing;
        this._sharingOn = !!sharing?.visible;
        sharing?.connectObject('notify::visible', () => {
            if (sharing.visible === this._sharingOn)
                return;
            this._sharingOn = sharing.visible;
            this._pushActivity({
                kind: 'sharing',
                icon: 'screen-shared-symbolic',
                styleClass: sharing.visible ? 'rsx-island-red' : '',
                title: sharing.visible ? _('Your screen is being shared') : _('Screen sharing stopped'),
                timeout: ACTIVITY_MS,
            });
        }, this);

        // Charger plugged in (laptops)
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device', null, (_o, res) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(res);
                } catch {
                    return;
                }
                if (!this._pill)
                    return;
                this._power = proxy;
                const state = () => proxy.get_cached_property('State')?.unpack() ?? 0;
                this._powerState = state();
                proxy.connectObject('g-properties-changed', () => {
                    const s = state();
                    const was = this._powerState;
                    this._powerState = s;
                    const present = proxy.get_cached_property('IsPresent')?.unpack();
                    // 1 charging, 2 discharging, 4 fully charged
                    if (!present || s === was || s !== 1 || quiet())
                        return;
                    const percent = Math.round(proxy.get_cached_property('Percentage')?.unpack() ?? 0);
                    this._pushActivity({
                        kind: 'power',
                        icon: 'battery-level-50-charging-symbolic',
                        styleClass: 'rsx-island-green',
                        title: _('Charging'),
                        subtitle: `${percent}%`,
                        timeout: ACTIVITY_MS,
                    });
                }, this);
            });
    }

    // -- activities -----------------------------------------------------------

    _pushActivity(activity) {
        activity.id = (this._nextId = (this._nextId ?? 0) + 1);
        // A newer one of the same kind replaces a waiting older one.
        if (activity.kind !== 'notification')
            this._activities = this._activities.filter(a => a.kind !== activity.kind);
        // Caps lock and the like replace each other right away.
        if (this._activity && this._activity.kind === activity.kind && activity.kind !== 'notification') {
            this._activity = null;
            this._activities.unshift(activity);
        } else {
            this._activities.push(activity);
        }
        if (!this._activity)
            this._nextActivity();
    }

    _nextActivity() {
        if (this._activityId)
            GLib.source_remove(this._activityId);
        this._activityId = 0;
        this._activity = this._activities.shift() ?? null;
        if (this._activity) {
            this._expanded = this._picker = false;
            this._armActivity(this._activity.timeout);
        }
        this._update();
    }

    _armActivity(ms) {
        this._activityId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._activityId = 0;
            // Stay while the mouse is on it.
            if (this._pill.hover)
                this._armActivity(1000);
            else
                this._nextActivity();
            return GLib.SOURCE_REMOVE;
        });
    }

    _endActivity() {
        this._nextActivity();
    }

    // -- timer ----------------------------------------------------------------

    _togglePicker() {
        this._picker = !this._picker;
        this._expanded = false;
        if (this._picker)
            Main.panel.statusArea.dateMenu?.menu.close();
        this._update();
    }

    _startTimer(ms) {
        this._timer = {kind: 'timer', end: now() + ms, remaining: ms, paused: false};
        this._picker = false;
        this._update();
    }

    _startStopwatch() {
        this._timer = {kind: 'stopwatch', start: now(), elapsed: 0, paused: false};
        this._picker = false;
        this._update();
    }

    _timerValue() {
        const t = this._timer;
        if (!t)
            return 0;
        if (t.kind === 'timer')
            return (t.paused ? t.remaining : Math.max(0, t.end - now())) + 999; // 0:01 until the very end
        return t.paused ? t.elapsed : now() - t.start;
    }

    _toggleTimerPause() {
        const t = this._timer;
        if (!t)
            return;
        if (t.kind === 'timer') {
            if (t.paused)
                t.end = now() + t.remaining;
            else
                t.remaining = Math.max(0, t.end - now());
        } else if (t.paused) {
            t.start = now() - t.elapsed;
        } else {
            t.elapsed = now() - t.start;
        }
        t.paused = !t.paused;
        this._refresh();
    }

    _stopTimer() {
        this._timer = null;
        this._update();
    }

    _syncTimerTick() {
        const on = !!this._timer && !this._timer.paused;
        if (on && !this._timerId) {
            this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                const t = this._timer;
                if (t?.kind === 'timer' && !t.paused && now() >= t.end) {
                    this._timerId = 0;
                    this._timer = null;
                    this._timerDone();
                    return GLib.SOURCE_REMOVE;
                }
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!on && this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _timerDone() {
        global.display.get_sound_player().play_from_theme(
            'alarm-clock-elapsed', _('Timer'), null);
        this._pushActivity({
            kind: 'timer-done',
            icon: 'alarm-symbolic',
            accent: true,
            title: _('Time is up'),
            subtitle: _('Click to close'),
            timeout: TIMER_DONE_MS,
        });
        this._update();
    }

    // -- teardown -------------------------------------------------------------

    disable() {
        for (const id of ['_activityId', '_hoverId', '_eqId', '_progressId', '_timerId', '_pauseId']) {
            if (this[id])
                GLib.source_remove(this[id]);
            this[id] = 0;
        }

        // Remove the per-instance override: back to GNOME's own method.
        if (this._tray)
            delete this._tray._showNotification;
        this._tray = null;

        this._mpris?.disconnectObject(this);
        for (const player of this._seen?.keys() ?? [])
            player.disconnectObject(this);
        this._seen?.clear();
        this._mpris = null;

        this._keymap?.disconnectObject(this);
        this._mixer?.disconnectObject(this);
        Main.screenshotUI?.disconnectObject(this);
        this._sharing?.disconnectObject(this);
        this._power?.disconnectObject(this);
        this._dateMenu?._clockDisplay?.disconnectObject(this);
        this._dateMenu?.menu.disconnectObject(this);
        this._dateMenu?.container.disconnectObject(this);
        this._dateMenu?.disconnectObject(this);
        this._keymap = this._mixer = this._sharing = this._power = this._dateMenu = null;

        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._pill?.destroy();
        this._pill = null;
        this._content = this._live = this._timer = null;
        this._activities = [];
        this._activity = null;
    }
}
