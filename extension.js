// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import {WindowPreview} from 'resource:///org/gnome/shell/ui/windowPreview.js';
import {WorkspaceLayout, WorkspaceBackground} from 'resource:///org/gnome/shell/ui/workspace.js';
import {WorkspacesView, ExtraWorkspaceView} from 'resource:///org/gnome/shell/ui/workspacesView.js';
import {ControlsManager, ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {WackLock} from './wack/wackLock.js';
import {CupertinoLogin} from './login.js';
import {ClipboardHistory} from './clipboard.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

// Saves original methods so a feature can restore them on disable.
class Patcher {
    constructor() {
        this._saved = [];
    }

    replace(obj, name, makeFn) {
        const orig = obj[name];
        this._saved.push([obj, name, orig]);
        obj[name] = makeFn(orig);
    }

    restore() {
        for (const [obj, name, orig] of this._saved.reverse())
            obj[name] = orig;
        this._saved = [];
    }
}

// ---------------------------------------------------------------------------
// Window captions: always show a compact "icon + title" pill under each
// window in the overview, instead of the big icon and hover-only title.
// ---------------------------------------------------------------------------

const CAPTION_ICON_SIZE = 18;
const CAPTION_SPACING = 8; // gap between window and caption
const WINDOW_ACTIVE_SIZE_INC = 5; // same as in windowPreview.js

class WindowCaptions {
    enable() {
        const previews = this._previews = new Set();
        const p = this._patcher = new Patcher();
        const proto = WindowPreview.prototype;

        p.replace(proto, '_init', orig => function (...args) {
            orig.apply(this, args);
            addCaption(this);
            previews.add(this);
            this.connect('destroy', () => previews.delete(this));
            this._updateIconScale();
        });

        // Fade the caption with the overview state (hidden in the app grid).
        p.replace(proto, '_updateIconScale', orig => function () {
            orig.call(this);
            if (this._rsxCaption)
                this._rsxCaption.opacity = Math.round(this._icon.scale_x * 255);
        });

        // Keep the caption below the window when the hovered window grows.
        p.replace(proto, '_adjustOverlayOffsets', orig => function () {
            orig.call(this);
            if (this._rsxCaption)
                this._rsxCaption.translation_y = this._title.translation_y;
        });

        // The stock hover title is replaced by our caption; keep it hidden.
        const hideTitle = preview => {
            if (!preview._rsxCaption)
                return;
            preview._title.remove_transition('opacity');
            preview._title.hide();
        };
        p.replace(proto, 'showOverlay', orig => function (animate) {
            orig.call(this, animate);
            hideTitle(this);
        });
        p.replace(proto, 'hideOverlay', orig => function (animate) {
            orig.call(this, animate);
            hideTitle(this);
        });

        // Space the caption takes below the window.
        p.replace(proto, 'overlapHeights', orig => function () {
            if (!this._rsxCaption)
                return orig.call(this);
            const [, height] = this._rsxCaption.get_preferred_height(-1);
            return [0, CAPTION_SPACING * scaleFactor() + height];
        });

        // No big icon hanging below the window anymore.
        p.replace(proto, 'chromeHeights', orig => function () {
            const [top, bottom] = orig.call(this);
            if (!this._rsxCaption)
                return [top, bottom];
            return [top, WINDOW_ACTIVE_SIZE_INC * scaleFactor()];
        });

        // Reserve room for captions between rows and under the bottom row,
        // so they don't get covered or stick out of the workspace card.
        p.replace(WorkspaceLayout.prototype, '_adjustSpacingAndPadding', orig =>
            function (rowSpacing, colSpacing, box) {
                const y2Before = box?.y2;
                const result = orig.call(this, rowSpacing, colSpacing, box);
                const window = this._sortedWindows[0];
                if (!window)
                    return result;

                const [, captionHeight] = window.overlapHeights();
                if (result[0] !== null)
                    result[0] += captionHeight;

                if (result[2]) {
                    const [, bottomOversize] = window.chromeHeights();
                    const needed = bottomOversize + captionHeight;
                    result[2].y2 = Math.min(result[2].y2, y2Before - needed);
                }
                return result;
            });
    }

    disable() {
        for (const preview of this._previews) {
            preview._rsxCaption.destroy();
            delete preview._rsxCaption;
            preview._icon.show();
        }
        this._previews = null;
        this._patcher.restore();
    }
}

function addCaption(preview) {
    const container = preview.window_container;
    const app = Shell.WindowTracker.get_default().get_window_app(preview.metaWindow);

    const caption = new St.BoxLayout({
        style_class: 'rsx-window-caption',
        reactive: true,
    });

    if (app) {
        const icon = app.create_icon_texture(CAPTION_ICON_SIZE);
        icon.y_align = Clutter.ActorAlign.CENTER;
        caption.add_child(icon);
    }

    const label = new St.Label({
        style_class: 'rsx-window-caption-label',
        text: preview._getCaption(),
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.single_line_mode = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    caption.add_child(label);

    preview.metaWindow.connectObject('notify::title',
        () => (label.text = preview._getCaption()), caption);

    // Centered right under the window.
    caption.add_constraint(new Clutter.BindConstraint({
        source: container,
        coordinate: Clutter.BindCoordinate.X,
    }));
    caption.add_constraint(new Clutter.BindConstraint({
        source: container,
        coordinate: Clutter.BindCoordinate.Y,
        offset: CAPTION_SPACING * scaleFactor(),
    }));
    caption.add_constraint(new Clutter.AlignConstraint({
        source: container,
        align_axis: Clutter.AlignAxis.X_AXIS,
        factor: 0.5,
    }));
    caption.add_constraint(new Clutter.AlignConstraint({
        source: container,
        align_axis: Clutter.AlignAxis.Y_AXIS,
        pivot_point: new Graphene.Point({x: -1, y: 0}),
        factor: 1,
    }));

    preview.add_child(caption);
    preview._rsxCaption = caption;

    preview._icon.hide();
    preview._title.hide();
}

// ---------------------------------------------------------------------------
// Equal window sizes: all previews get the same height, so rows line up.
// GNOME scales each window by its own height; we normalize every window
// to the monitor height instead. Width still follows the window's shape.
// ---------------------------------------------------------------------------

class EqualWindowSizes {
    enable() {
        const self = this;
        const p = this._patcher = new Patcher();

        // The layout strategy class isn't exported, so patch it the first
        // time we see an instance of it, then redo that layout.
        p.replace(WorkspaceLayout.prototype, '_createBestLayout', orig => function (area) {
            let layout = orig.call(this, area);
            if (!self._strategyPatched && this._layoutStrategy) {
                self._strategyPatched = true;
                p.replace(Object.getPrototypeOf(this._layoutStrategy), '_computeWindowScale',
                    () => function (window) {
                        return this._monitor.height / Math.max(window.boundingBox.height, 1);
                    });
                layout = orig.call(this, area);
            }
            return layout;
        });
    }

    disable() {
        this._patcher.restore();
    }
}

// ---------------------------------------------------------------------------
// Spring animation: windows overshoot a little and settle, both when the
// overview opens and when it closes. Also slower, smoother timing.
//
// Window positions are a linear mix between "desktop" (0) and "overview
// slot" (1), driven by each workspace's state value. GNOME eases that value
// by time; we turn it back into time and run it through a damped spring.
// ---------------------------------------------------------------------------

const OPEN_TIME = 550; // ms, GNOME default is 250
const CLOSE_TIME = 450; // ms, GNOME default is 250
const SPRING_DAMPING = 0.72; // lower = more bounce (0.72 ≈ 3.5% overshoot)
const SPRING_FREQUENCY = 7.0;

// Damped spring from 0 to 1 over t in [0, 1], starting at rest.
function spring(t) {
    const z = SPRING_DAMPING;
    const w = SPRING_FREQUENCY;
    const wd = w * Math.sqrt(1 - z * z);
    const x = s => 1 - Math.exp(-z * w * s) *
        (Math.cos(wd * s) + (z * w / wd) * Math.sin(wd * s));
    return x(t) - (x(1) - 1) * t; // land exactly on 1 at the end
}

class SpringOverview {
    enable() {
        const p = this._patcher = new Patcher();
        // null, or how to turn the eased value back into time
        let mode = null;

        // Open: GNOME's code, longer duration. Spring only for the
        // window picker (not when opening straight into the app grid).
        p.replace(ControlsManager.prototype, 'animateToOverview', () => function (state, callback) {
            this._ignoreShowAppsButtonToggle = true;
            if (state === ControlsState.WINDOW_PICKER)
                mode = 'open';
            this._stateAdjustment.value = ControlsState.HIDDEN;
            this._stateAdjustment.ease(state, {
                duration: OPEN_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_SINE,
                onStopped: () => {
                    mode = null;
                    callback?.();
                },
            });
            this.dash.showAppsButton.checked = state === ControlsState.APP_GRID;
            this._ignoreShowAppsButtonToggle = false;
        });

        // Close: same, spring only when closing from the window picker.
        p.replace(ControlsManager.prototype, 'animateFromOverview', () => function (callback) {
            this._ignoreShowAppsButtonToggle = true;
            if (this._stateAdjustment.value === ControlsState.WINDOW_PICKER)
                mode = 'close';
            this._stateAdjustment.ease(ControlsState.HIDDEN, {
                duration: CLOSE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onStopped: () => {
                    mode = null;
                    this.dash.showAppsButton.checked = false;
                    this._ignoreShowAppsButtonToggle = false;
                    callback?.();
                },
            });
        });

        const apply = workspace => {
            const adj = workspace.stateAdjustment;
            const v = adj.value;
            if (!mode || v <= 0 || v >= 1)
                return;
            // Allow going past 0 and 1.
            adj.lower = -1;
            adj.upper = 2;
            if (mode === 'open') {
                const t = Math.asin(v) * 2 / Math.PI; // undo EASE_OUT_SINE
                adj.value = spring(t);
            } else {
                const t = 1 - Math.cbrt(v); // undo EASE_OUT_CUBIC towards 0
                adj.value = 1 - spring(t);
            }
        };

        p.replace(WorkspacesView.prototype, '_updateWorkspacesState', orig => function () {
            orig.call(this);
            this._workspaces.forEach(apply);
        });
        p.replace(ExtraWorkspaceView.prototype, '_updateWorkspaceMode', orig => function () {
            orig.call(this);
            apply(this._workspace);
        });

        // Minimized windows fade by the state value: keep opacity in range,
        // and hide them below 0 (their size would turn negative).
        p.replace(WorkspaceLayout.prototype, '_syncOpacity', () => function (actor, metaWindow) {
            if (metaWindow.showing_on_its_workspace())
                return;
            const v = this._stateAdjustment.value;
            if (v < 0 && actor.visible) {
                actor._rsxHidden = true;
                actor.hide();
            } else if (v >= 0 && actor._rsxHidden) {
                delete actor._rsxHidden;
                actor.show();
            }
            actor.opacity = Math.round(Math.clamp(v, 0, 1) * 255);
        });

        // Corner radius can't go negative.
        p.replace(WorkspaceBackground.prototype, '_updateBorderRadius', orig => function () {
            const adj = this._stateAdjustment;
            if (adj.value >= 0 && adj.value <= 1) {
                orig.call(this);
                return;
            }
            const radius = scaleFactor() * 30 * Math.clamp(adj.value, 0, 1);
            this._bgManager.backgroundActor.content.rounded_clip_radius = radius;
        });
    }

    disable() {
        this._patcher.restore();
    }
}

// ---------------------------------------------------------------------------
// Blurred top bar: semi-transparent panel over a Gaussian-blurred copy of
// the wallpaper. Windows never go under the panel, so the wallpaper is
// exactly what's behind it (same approach as Blur My Shell's static blur).
// In the overview the panel is already transparent, so the blur fades out.
// ---------------------------------------------------------------------------

const PANEL_BLUR_BRIGHTNESS = 0.75; // < 1 darkens, keeps text readable

class BlurredPanel {
    constructor(settings) {
        this._settings = settings;
    }

    enable() {
        const {layoutManager} = Main;
        const panelBox = layoutManager.panelBox;

        Main.panel.add_style_class_name('rsx-blur-panel');

        // Sits right under the panel, same position and size, clipped.
        this._bin = new Clutter.Actor({clip_to_allocation: true});
        this._bin.add_constraint(new Clutter.BindConstraint({
            source: panelBox,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        layoutManager.uiGroup.insert_child_below(this._bin, panelBox);
        panelBox.bind_property('visible', this._bin, 'visible',
            GObject.BindingFlags.SYNC_CREATE);

        this._bgGroup = new Meta.BackgroundGroup({
            layout_manager: new Clutter.BinLayout(),
        });
        const blur = new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            brightness: PANEL_BLUR_BRIGHTNESS,
        });
        this._bgGroup.add_effect(blur);
        this._settings.bind('panel-blur-radius', blur, 'radius',
            Gio.SettingsBindFlags.GET);
        this._bin.add_child(this._bgGroup);

        // Monitors may not be ready yet while the shell is starting up.
        if (layoutManager._startingUp) {
            layoutManager.connectObject('startup-complete',
                () => this._createBackground(), this);
        } else {
            this._createBackground();
        }
        layoutManager.connectObject('monitors-changed',
            () => this._createBackground(), this);

        // Fade out together with the overview animation (whatever its speed,
        // including touchpad gestures), not on a separate timer.
        this._overviewState = Main.overview._overview?._controls?._stateAdjustment ?? null;
        if (this._overviewState) {
            this._overviewState.connectObject('notify::value',
                () => this._syncOpacity(), this);
            // On shell shutdown the panel goes away before the overview.
            this._bin.connect('destroy', () => this._overviewState?.disconnectObject(this));
            this._syncOpacity();
        } else {
            // Fallback if GNOME internals change.
            Main.overview.connectObject(
                'showing', () => (this._bin.opacity = 0),
                'hidden', () => (this._bin.opacity = 255),
                this);
        }
    }

    _syncOpacity() {
        // 0 = desktop, 1 = window picker (2 = app grid).
        const progress = Math.clamp(this._overviewState.value, 0, 1);
        this._bin.opacity = Math.round(255 * (1 - progress));
    }

    // Wallpaper of the panel's monitor, placed so it lines up with the screen.
    // Until it exists the blur layer stays hidden (otherwise it paints black).
    _createBackground() {
        this._bgManager?.destroy();
        this._bgManager = null;
        this._bgGroup.hide();

        const {layoutManager} = Main;
        const monitor = layoutManager.primaryMonitor;
        if (!monitor || monitor.width < 1 || monitor.height < 1)
            return;

        try {
            this._bgManager = new Background.BackgroundManager({
                container: this._bgGroup,
                monitorIndex: layoutManager.primaryIndex,
                controlPosition: false,
                useContentSize: false,
            });
        } catch (e) {
            console.warn(`rsx@rsx: panel blur background failed: ${e.message}`);
            return;
        }

        // The panel sits at the monitor's top-left corner.
        this._bgGroup.set_position(0, 0);
        this._bgGroup.set_size(monitor.width, monitor.height);
        this._bgGroup.show();
    }

    disable() {
        Main.overview.disconnectObject(this);
        this._overviewState?.disconnectObject(this);
        this._overviewState = null;
        Main.layoutManager.disconnectObject(this);
        this._bgManager?.destroy();
        this._bgManager = null;
        Gio.Settings.unbind(this._bgGroup.get_effects()[0], 'radius');
        this._bin.destroy();
        this._bin = null;
        this._bgGroup = null;
        Main.panel.remove_style_class_name('rsx-blur-panel');
    }
}

// ---------------------------------------------------------------------------
// Lock screen: WACK (macOS Sonoma style), vendored in ./wack (GPL-3.0).
// WACK expects to be enabled only while the screen is locked, so we create
// it when the session enters lock mode and destroy it on unlock, the same
// way GNOME did for the standalone extension. If WACK fails, its partial
// changes are undone and the stock lock screen stays.
// ---------------------------------------------------------------------------

class CupertinoLock {
    constructor(_settings, extension) {
        this._extension = extension;
    }

    enable() {
        Main.sessionMode.connectObject('updated', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const locked = Main.sessionMode.isLocked && Main.screenShield?._dialog;
        if (locked && !this._wack)
            this._start();
        else if (!locked && this._wack)
            this._stop();
    }

    _start() {
        this._wack = new WackLock(this._extension);
        try {
            this._wack.enable();
        } catch (e) {
            console.error(`rsx@rsx: WACK lock screen failed, using stock: ${e}\n${e.stack}`);
            this._stop();
        }
    }

    _stop() {
        try {
            this._wack?.disable();
        } catch (e) {
            console.error(`rsx@rsx: WACK cleanup failed: ${e}`);
        }
        this._wack = null;
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        if (this._wack)
            this._stop();
    }
}

// ---------------------------------------------------------------------------
// English layout on the lock screen: switch to the English input source when
// the screen locks, and back to the previous one on unlock.
// (Idea from "Force English On Lock" by VitalyOstanin, GPL-2.0-or-later.)
// ---------------------------------------------------------------------------

function findEnglishSource() {
    const sources = Object.values(getInputSourceManager()?.inputSources ?? {});
    const isEnglish = src => src.type === 'xkb' && /^(us|gb)(\+|$)/.test(src.id);
    return sources.find(isEnglish) ?? sources.find(src => src.index === 0) ?? null;
}

class EnglishOnLock {
    enable() {
        this._locked = false;
        this._timeouts = new Set();
        Main.sessionMode.connectObject('updated', () => this._sync(), this);
        // Also on lock-screen-shown: a focus change right after locking may
        // switch the layout back, so apply once more when the shield settles.
        Main.screenShield?.connectObject('lock-screen-shown', () => {
            if (this._locked)
                this._forceEnglish();
        }, this);
        this._sync();
    }

    _sync() {
        const locked = Main.sessionMode.isLocked;
        if (locked === this._locked)
            return;
        this._locked = locked;

        const manager = getInputSourceManager();
        if (locked) {
            this._restoreSource = manager?.currentSource ?? null;
            this._forceEnglish();
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._timeouts.delete(id);
                if (this._locked)
                    this._forceEnglish();
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
        } else {
            this._restoreSource?.activate(false);
            this._restoreSource = null;
        }
    }

    _forceEnglish() {
        const english = findEnglishSource();
        if (english && getInputSourceManager().currentSource !== english)
            english.activate(false);
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        Main.screenShield?.disconnectObject(this);
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts = null;
        this._restoreSource = null;
    }
}

// ---------------------------------------------------------------------------

const FEATURES = {
    'window-captions': WindowCaptions,
    'equal-window-sizes': EqualWindowSizes,
    'spring-animation': SpringOverview,
    'blur-panel': BlurredPanel,
    'cupertino-lock': CupertinoLock,
    'english-on-lock': EnglishOnLock,
    'cupertino-login': CupertinoLogin,
    'clipboard-history': ClipboardHistory,
};

// On the login screen (GDM) only the login look runs.
const GREETER_FEATURES = ['cupertino-login'];

export default class RsxExtension extends Extension {
    enable() {
        this._active = new Map();
        this._settings = this.getSettings();
        this._settings.connectObject('changed', (_s, key) => this._sync(key), this);
        Object.keys(FEATURES).forEach(key => this._sync(key));
    }

    _sync(key) {
        const Feature = FEATURES[key];
        if (!Feature)
            return;
        if (Main.sessionMode.isGreeter && !GREETER_FEATURES.includes(key))
            return;

        const wanted = this._settings.get_boolean(key);
        const current = this._active.get(key);
        if (wanted && !current) {
            const feature = new Feature(this._settings, this);
            feature.enable();
            this._active.set(key, feature);
        } else if (!wanted && current) {
            current.disable();
            this._active.delete(key);
        }
    }

    disable() {
        this._settings.disconnectObject(this);
        this._settings = null;
        [...this._active.values()].reverse().forEach(f => f.disable());
        this._active = null;
    }
}
