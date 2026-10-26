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
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import {WindowPreview} from 'resource:///org/gnome/shell/ui/windowPreview.js';
import {WorkspaceLayout} from 'resource:///org/gnome/shell/ui/workspace.js';
import {WorkspacesView, ExtraWorkspaceView} from 'resource:///org/gnome/shell/ui/workspacesView.js';
import {ControlsManager, ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {WackLock} from './wack/wackLock.js';
import {CupertinoLogin} from './login.js';
import {ClipboardHistory} from './clipboard.js';
import {LatinShortcuts} from './layoutShortcuts.js';
import {LockSmoke} from './smoke.js';
import {ScreenCorners} from './corners.js';
import {MacSwitcher} from './switcher.js';
import {CenterWindows, SmoothWindows} from './windows.js';
import {MacOsd} from './osd.js';
import {DynamicIsland} from './island.js';
import {emphasized} from './motion.js';
import {LockMedia} from './lockmedia.js';
import {ShakeCursor} from './cursor.js';
import {Runner} from './runner.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';
import {isRussian, setLanguage} from './i18n.js';

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

// The overview's layout strategy class isn't exported: run GNOME's layout
// once on an empty stand-in workspace to get hold of it.
let strategyProto = null;
function layoutStrategyProto() {
    if (!strategyProto) {
        const proto = WorkspaceLayout.prototype;
        // At login the extension starts before monitors are known, so lend
        // GNOME a stand-in monitor for this one call.
        const {monitors} = Main.layoutManager;
        monitors.push({x: 0, y: 0, width: 100, height: 100});
        const fake = {
            _spacing: 0,
            _sortedWindows: [],
            _monitorIndex: monitors.length - 1,
            _adjustSpacingAndPadding: proto._adjustSpacingAndPadding,
            _isBetterScaleAndSpace: proto._isBetterScaleAndSpace,
        };
        try {
            proto._createBestLayout.call(fake, {x: 0, y: 0, width: 100, height: 100});
        } finally {
            monitors.pop();
        }
        strategyProto = Object.getPrototypeOf(fake._layoutStrategy);
    }
    return strategyProto;
}

class EqualWindowSizes {
    enable() {
        this._patcher = new Patcher();
        this._patcher.replace(layoutStrategyProto(), '_computeWindowScale',
            () => function (window) {
                return this._monitor.height / Math.max(window.boundingBox.height, 1);
            });
    }

    disable() {
        this._patcher.restore();
    }
}

// ---------------------------------------------------------------------------
// Window order: drag a preview onto another one in the overview to swap
// places; the others make room while you drag. GNOME arranges windows by
// where they are on the desktop; we keep the order the user set instead
// (new windows go to the end, in GNOME's order).
// ---------------------------------------------------------------------------

class WindowOrder {
    enable() {
        const self = this;
        this._order = []; // stable sequences of windows, in the user's order
        const p = this._patcher = new Patcher();
        const strategy = layoutStrategyProto();

        // GNOME's computeLayout, with our order instead of the vertical
        // position for filling the rows.
        p.replace(strategy, 'computeLayout', () => function (windows, {numRows}) {
            const sorted = self._sort(windows);
            const scaled = sorted.map(w => {
                const s = this._computeWindowScale(w);
                return {w, width: w.boundingBox.width * s, height: w.boundingBox.height * s};
            });
            const totalWidth = scaled.reduce((sum, x) => sum + x.width, 0);
            const idealRowWidth = totalWidth / numRows;

            const rows = [];
            let i = 0;
            for (let r = 0; r < numRows; r++) {
                const row = this._newRow();
                rows.push(row);
                for (; i < scaled.length; i++) {
                    const {w, width, height} = scaled[i];
                    if (!this._keepSameRow(row, w, width, idealRowWidth) && r !== numRows - 1)
                        break;
                    row.windows.push(w);
                    row.fullWidth += width;
                    row.fullHeight = Math.max(row.fullHeight, height);
                }
            }

            let gridHeight = 0;
            let maxRow;
            for (const row of rows) {
                if (!maxRow || row.fullWidth > maxRow.fullWidth)
                    maxRow = row;
                gridHeight += row.fullHeight;
            }
            return {
                numRows,
                rows,
                maxColumns: maxRow.windows.length,
                gridWidth: maxRow.fullWidth,
                gridHeight,
            };
        });
        // Rows keep our order too.
        p.replace(strategy, '_sortRow', () => function (row) {
            row.windows = self._sort(row.windows);
        });

        // The dragged preview keeps its gap in the grid, but isn't put back
        // into it until the drag is over.
        p.replace(WorkspaceLayout.prototype, '_getWindowSlots', orig => function (box) {
            const slots = orig.call(this, box);
            for (const slot of slots) {
                if (slot[4].inDrag)
                    slot[4]._rsxSlot = slot;
            }
            return slots.filter(slot => !slot[4].inDrag);
        });

        this._monitor = {dragMotion: event => this._dragMotion(event)};
        DND.addDragMonitor(this._monitor);
        Main.overview.connectObject(
            'window-drag-cancelled', (_o, win) => this._aimSnapBack(win?._delegate),
            'window-drag-end', (_o, win) => this._land(win?._delegate),
            this);
    }

    // Dropped back on its own workspace: GNOME would fly the window to its
    // old place and then jump to the new one. Fly it to the new place.
    _aimSnapBack(preview) {
        const slot = preview?._rsxSlot;
        const layout = preview?._workspace?._container?.layout_manager;
        const draggable = preview?._draggable;
        const width = preview?.allocation.get_width();
        if (!slot || !(layout instanceof WorkspaceLayout) || !draggable || !width)
            return;
        const k = layout._container.allocation.get_width() /
            (layout._windowSlotsBox?.get_width() || 1);
        const [x, y, w, h] = slot.map(v => v * k);
        draggable._dragOrigX = x;
        draggable._dragOrigY = y;
        draggable._dragOrigScale = w / width;
        preview._rsxLanding = new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h});
    }

    // Back in the grid: settle at the new place at full size, then lay out.
    _land(preview) {
        const box = preview?._rsxLanding;
        if (preview)
            preview._rsxSlot = preview._rsxLanding = null;
        this._lastTarget = null;
        if (box) {
            preview.set_scale(1, 1);
            preview.allocate(box);
        }
        this._relayout(preview);
    }

    _seq(preview) {
        return preview.metaWindow.get_stable_sequence();
    }

    // Previews in the user's order; unknown ones are added to the end, top
    // to bottom and left to right as they are on the desktop.
    _sort(windows) {
        const alive = new Set(global.get_window_actors().map(a => a.meta_window.get_stable_sequence()));
        this._order = this._order.filter(seq => alive.has(seq));
        const known = new Set(this._order);
        const fresh = windows.filter(w => !known.has(this._seq(w)))
            .sort((a, b) => a.windowCenter.y - b.windowCenter.y || a.windowCenter.x - b.windowCenter.x);
        this._order.push(...fresh.map(w => this._seq(w)));
        const rank = new Map(this._order.map((seq, i) => [seq, i]));
        return windows.slice().sort((a, b) => rank.get(this._seq(a)) - rank.get(this._seq(b)));
    }

    _dragMotion(event) {
        const source = event.source;
        if (!(source instanceof WindowPreview) || !source.inDrag)
            return DND.DragMotionResult.CONTINUE;
        let target = event.targetActor;
        while (target && !(target instanceof WindowPreview))
            target = target.get_parent();
        // Skip previews that are still sliding into place.
        if (target !== this._lastTarget)
            this._lastTarget = null;
        // Swap once per window the pointer enters: after a swap the window
        // under the pointer changes, and swapping again would bounce back.
        if (!target || target === source || target === this._lastTarget ||
            target._workspace !== source._workspace || target.get_transition('allocation'))
            return DND.DragMotionResult.CONTINUE;
        this._lastTarget = target;

        const from = this._order.indexOf(this._seq(source));
        const to = this._order.indexOf(this._seq(target));
        if (from < 0 || to < 0)
            return DND.DragMotionResult.CONTINUE;
        this._order.splice(from, 1);
        this._order.splice(to, 0, this._seq(source));
        this._relayout(source);
        return DND.DragMotionResult.CONTINUE;
    }

    _relayout(preview) {
        const layout = preview?._workspace?._container?.layout_manager;
        if (!(layout instanceof WorkspaceLayout))
            return;
        // GNOME retargets windows that are still moving by swapping the end
        // point mid-way, which makes them jump. Stop them where they are
        // instead, so the new move starts smoothly from there.
        for (const [child, info] of layout._windows ?? []) {
            if (!info.currentTransition)
                continue;
            info.currentTransition = null;
            child.remove_transition('allocation');
        }
        layout._needsLayout = true;
        layout.layout_changed();
    }

    disable() {
        DND.removeDragMonitor(this._monitor);
        Main.overview.disconnectObject(this);
        this._patcher.restore();
        this._order = [];
    }
}

// ---------------------------------------------------------------------------
// Smooth overview: windows glide to their places on a quick-start,
// soft-landing curve (no bounce), both when the overview opens and closes.
//
// Window positions are a linear mix between "desktop" (0) and "overview
// slot" (1), driven by each workspace's state value. GNOME eases that value
// by time; we turn it back into time and run it through our curve.
// ---------------------------------------------------------------------------

const OPEN_TIME = 450; // ms, GNOME default is 250
const CLOSE_TIME = 380; // ms, GNOME default is 250

class SmoothOverview {
    enable() {
        const p = this._patcher = new Patcher();
        // null, or how to turn the eased value back into time
        let mode = null;

        // Open: GNOME's code, longer duration. Our curve only for the
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

        // Close: same, our curve only when closing from the window picker.
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
            if (mode === 'open') {
                const t = Math.asin(v) * 2 / Math.PI; // undo EASE_OUT_SINE
                adj.value = emphasized(t);
            } else {
                const t = 1 - Math.cbrt(v); // undo EASE_OUT_CUBIC towards 0
                adj.value = 1 - emphasized(t);
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
// No "Add World Clocks…" button in the calendar menu. GNOME shows it again
// whenever the clocks app changes, so hide it each time it appears.
// ---------------------------------------------------------------------------

class HideWorldClocks {
    enable() {
        this._item = Main.panel.statusArea.dateMenu?._clocksItem ?? null;
        this._item?.connectObject('notify::visible', () => {
            if (this._item.visible)
                this._item.hide();
        }, this);
        this._item?.hide();
    }

    disable() {
        this._item?.disconnectObject(this);
        this._item?._sync?.();
        this._item = null;
    }
}

// ---------------------------------------------------------------------------
// Fewer quick settings: no power mode (tile and top bar icon), night light
// or dark style. GNOME shows them again when their state changes, so hide
// them each time they appear.
// ---------------------------------------------------------------------------

class TidyQuickSettings {
    enable() {
        this._hidden = new Map(); // actor -> was it visible
        const qs = this._qs = Main.panel.statusArea.quickSettings;
        // At login GNOME is still building quick settings: wait for them.
        if (qs && !this._ready())
            qs._indicators.connectObject('child-added', () => this._ready() && this._hide(), this);
        else
            this._hide();
    }

    _ready() {
        const qs = this._qs;
        return !!(qs?._powerProfiles && qs._nightLight && qs._darkMode);
    }

    _hide() {
        const qs = this._qs;
        qs?._indicators.disconnectObject(this);
        for (const indicator of [qs?._powerProfiles, qs?._nightLight, qs?._darkMode]) {
            if (!indicator || this._hidden.has(indicator))
                continue;
            for (const actor of [indicator, ...indicator.quickSettingsItems ?? []]) {
                this._hidden.set(actor, actor.visible);
                actor.connectObject('notify::visible', () => {
                    if (actor.visible) {
                        this._hidden.set(actor, true);
                        actor.hide();
                    }
                }, this);
                actor.hide();
            }
        }
    }

    disable() {
        this._qs?._indicators.disconnectObject(this);
        this._qs = null;
        for (const [actor, wasVisible] of this._hidden ?? []) {
            actor.disconnectObject(this);
            actor.visible = wasVisible;
        }
        this._hidden = null;
    }
}

// ---------------------------------------------------------------------------
// The clock and calendar at the right end of the top bar, like on macOS.
// GNOME puts the clock back in the middle whenever the session mode
// changes (lock, unlock), so move it again each time.
// ---------------------------------------------------------------------------

class ClockRight {
    enable() {
        this._move();
        Main.sessionMode.connectObject('updated', () => this._move(), this);
    }

    _move() {
        const clock = Main.panel.statusArea.dateMenu?.container;
        const right = Main.panel._rightBox;
        if (!clock || clock.get_parent() === right)
            return;
        clock.get_parent()?.remove_child(clock);
        right.add_child(clock);
        // The clock keeps room on both sides for the unread dot when it's
        // centered; at the edge that only looks like a gap.
        Main.panel.statusArea.dateMenu.add_style_class_name('rsx-clock-right');
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (clock && clock.get_parent() === Main.panel._rightBox) {
            Main.panel._rightBox.remove_child(clock);
            Main.panel._centerBox.insert_child_at_index(clock, 0);
        }
        Main.panel.statusArea.dateMenu?.remove_style_class_name('rsx-clock-right');
    }
}

// ---------------------------------------------------------------------------
// Short top bar date: "пн, 21.11, 14:11". GNOME keeps setting the clock text
// (every minute, or second); each time we rewrite it in our format. Seconds
// and the 12/24-hour choice follow GNOME's own settings.
// ---------------------------------------------------------------------------

const WEEKDAYS_RU = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const WEEKDAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

class ShortDate {
    enable() {
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._label = Main.panel.statusArea.dateMenu?._clockDisplay ?? null;
        this._label?.connectObject('notify::text', () => this._sync(), this);
        this._interface.connectObject(
            'changed::clock-show-seconds', () => this._sync(),
            'changed::clock-format', () => this._sync(), this);
        this._sync();
    }

    _text() {
        const now = GLib.DateTime.new_now_local();
        const day = (isRussian() ? WEEKDAYS_RU : WEEKDAYS_EN)[now.get_day_of_week() - 1];
        const seconds = this._interface.get_boolean('clock-show-seconds') ? ':%S' : '';
        const time = this._interface.get_string('clock-format') === '12h'
            ? now.format(`%l:%M${seconds} %p`).trim()
            : now.format(`%H:%M${seconds}`);
        return `${day}, ${now.format('%d.%m')}, ${time}`;
    }

    _sync() {
        const text = this._text();
        if (this._label && this._label.text !== text)
            this._label.text = text;
    }

    disable() {
        this._interface?.disconnectObject(this);
        this._interface = null;
        this._label?.disconnectObject(this);
        // Back to GNOME's text.
        const clock = Main.panel.statusArea.dateMenu?._clock;
        if (this._label && clock)
            this._label.text = clock.clock;
        this._label = null;
    }
}

// ---------------------------------------------------------------------------

const FEATURES = {
    'short-date': ShortDate,
    'clock-right': ClockRight,
    'tidy-quick-settings': TidyQuickSettings,
    'window-captions': WindowCaptions,
    'equal-window-sizes': EqualWindowSizes,
    'window-order': WindowOrder,
    'spring-animation': SmoothOverview,
    'blur-panel': BlurredPanel,
    'screen-corners': ScreenCorners,
    'hide-world-clocks': HideWorldClocks,
    'mac-switcher': MacSwitcher,
    'center-windows': CenterWindows,
    'spring-windows': SmoothWindows,
    'mac-osd': MacOsd,
    'dynamic-island': DynamicIsland,
    'shake-cursor': ShakeCursor,
    'runner': Runner,
    'cupertino-lock': CupertinoLock,
    'english-on-lock': EnglishOnLock,
    'lock-smoke': LockSmoke,
    'lock-media': LockMedia,
    'cupertino-login': CupertinoLogin,
    'clipboard-history': ClipboardHistory,
    'latin-shortcuts': LatinShortcuts,
};

// On the login screen (GDM) only the login look runs.
const GREETER_FEATURES = ['cupertino-login', 'screen-corners'];

export default class RsxExtension extends Extension {
    enable() {
        this._active = new Map();
        this._settings = this.getSettings();
        setLanguage(this._settings.get_string('language'));
        this._settings.connectObject('changed', (_s, key) => {
            if (key === 'language')
                this._changeLanguage();
            else
                this._sync(key);
        }, this);
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

    // Restart every feature so its text is built again in the new language.
    _changeLanguage() {
        setLanguage(this._settings.get_string('language'));
        const keys = [...this._active.keys()];
        [...this._active.values()].reverse().forEach(f => f.disable());
        this._active.clear();
        keys.forEach(key => this._sync(key));
    }

    disable() {
        this._settings.disconnectObject(this);
        this._settings = null;
        [...this._active.values()].reverse().forEach(f => f.disable());
        this._active = null;
    }
}
