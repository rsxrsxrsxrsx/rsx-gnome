// SPDX-License-Identifier: GPL-3.0-or-later
//
// System monitor in the top bar, left of the tray icons: CPU load, memory
// and CPU temperature (and optionally network speed). A click opens details:
// a two-minute graph of CPU and memory, swap, the NVIDIA GPU, the disk,
// network and the processes that use the most CPU right now (a click on one
// quits it).
//
// Everything is read from /proc and /sys, which are cheap to read. The GPU
// (nvidia-smi) and the process list cost more, so they only run while the
// menu is open.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {_} from './i18n.js';
import {COMPACT_MAX_WIDTH} from './island.js';
import {confirm} from './confirm.js';

const INTERVAL = 2; // seconds
const TOP_PROCESSES = 6;
const HISTORY = 60; // samples: two minutes at INTERVAL
const CONFIRM_MS = 3000;
// Never offered for killing: the session would go with them.
const PROTECTED = new Set([
    'gnome-shell', 'gnome-session-binary', 'gnome-session-service', 'Xwayland', 'systemd',
    'dbus-daemon', 'dbus-broker', 'pipewire', 'wireplumber', 'pipewire-pulse', 'gsd-xsettings',
    'gnome-keyring-daemon', 'kworker', 'kthreadd', 'init',
]);
// Whole disks in /proc/diskstats (not their partitions).
const WHOLE_DISK = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|mmcblk\d+)$/;
// Room kept free between the island (at its widest) and the monitor.
const ISLAND_GAP = 16;
const MONITOR_APPS = [
    'net.nokyan.Resources.desktop',
    'io.missioncenter.MissionCenter.desktop',
    'org.gnome.SystemMonitor.desktop',
    'gnome-system-monitor.desktop',
];
// Interfaces whose traffic is already counted on a real one (or is local).
const VIRTUAL_NET = /^(lo|veth|docker|br-|virbr|tun|tap|wg|vnet)/;

const decoder = new TextDecoder();

function read(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch {
        return null;
    }
}

// /proc/stat "cpu" lines → [{busy, total}], the first one for all CPUs.
function readCpu() {
    const text = read('/proc/stat');
    if (!text)
        return [];
    const cpus = [];
    for (const line of text.split('\n')) {
        if (!line.startsWith('cpu'))
            break;
        const v = line.split(/\s+/).slice(1).map(Number);
        // user nice system idle iowait irq softirq steal (guest is in user)
        const idle = v[3] + (v[4] ?? 0);
        const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
        cpus.push({busy: total - idle, total});
    }
    return cpus;
}

// Bytes.
function readMemory() {
    const text = read('/proc/meminfo');
    const info = {};
    for (const line of text?.split('\n') ?? []) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m)
            info[m[1]] = Number(m[2]) * 1024;
    }
    const total = info.MemTotal ?? 0;
    const available = info.MemAvailable ?? info.MemFree ?? 0;
    const swapTotal = info.SwapTotal ?? 0;
    return {
        total,
        used: total - available,
        swapTotal,
        swapUsed: swapTotal - (info.SwapFree ?? 0),
    };
}

// The CPU's temperature sensor: Intel's package, AMD's Tctl, or anything
// that looks like a CPU.
function findCpuSensor() {
    const preferred = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal'];
    let found = null;
    let rank = Infinity;
    for (let i = 0; i < 32; i++) {
        const dir = `/sys/class/hwmon/hwmon${i}`;
        const name = read(`${dir}/name`)?.trim();
        if (name === undefined)
            continue;
        const r = preferred.indexOf(name);
        if (r < 0 || r >= rank)
            continue;
        let input = `${dir}/temp1_input`;
        for (let t = 1; t < 16; t++) {
            const label = read(`${dir}/temp${t}_label`)?.trim();
            if (label === 'Package id 0' || label === 'Tctl' || label === 'Tdie') {
                input = `${dir}/temp${t}_input`;
                break;
            }
        }
        found = input;
        rank = r;
    }
    if (!found && read('/sys/class/thermal/thermal_zone0/temp') !== null)
        found = '/sys/class/thermal/thermal_zone0/temp';
    return found;
}

function readNet() {
    let rx = 0, tx = 0;
    for (const line of read('/proc/net/dev')?.split('\n').slice(2) ?? []) {
        const [name, rest] = line.split(':');
        if (!rest || VIRTUAL_NET.test(name.trim()))
            continue;
        const v = rest.trim().split(/\s+/).map(Number);
        rx += v[0];
        tx += v[8];
    }
    return {rx, tx};
}

// Bytes read and written by all disks since boot.
function readDisks() {
    let read_ = 0, written = 0;
    for (const line of read('/proc/diskstats')?.split('\n') ?? []) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || !WHOLE_DISK.test(f[2]))
            continue;
        read_ += Number(f[5]) * 512;
        written += Number(f[9]) * 512;
    }
    return {read: read_, written};
}

// Size and free space of the disk with the home folder.
function readSpace() {
    try {
        const info = Gio.File.new_for_path(GLib.get_home_dir())
            .query_filesystem_info('filesystem::size,filesystem::free', null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        return size ? {size, used: size - free} : null;
    } catch {
        return null;
    }
}

function ownedByMe(pid) {
    try {
        const info = Gio.File.new_for_path(`/proc/${pid}`).query_info('unix::uid', Gio.FileQueryInfoFlags.NONE, null);
        return info.get_attribute_uint32('unix::uid') === new Gio.Credentials().get_unix_user();
    } catch {
        return false;
    }
}

// {name → {ticks, rss}} for every process, grouped by name (a browser is
// one line, not thirty).
function readProcesses() {
    const page = 4096;
    const groups = new Map();
    let dir;
    try {
        dir = GLib.Dir.open('/proc', 0);
    } catch {
        return groups;
    }
    let pid;
    while ((pid = dir.read_name()) !== null) {
        if (!/^\d+$/.test(pid))
            continue;
        const stat = read(`/proc/${pid}/stat`);
        if (!stat)
            continue;
        const open = stat.indexOf('(');
        const close = stat.lastIndexOf(')');
        const name = stat.slice(open + 1, close);
        const f = stat.slice(close + 2).split(' ');
        // f[0] is field 3 (state): utime is 14, stime 15, rss 24.
        const ticks = Number(f[11]) + Number(f[12]);
        const rss = Number(f[21]) * page;
        const g = groups.get(name) ?? {ticks: 0, rss: 0, pids: []};
        g.ticks += ticks;
        g.rss += rss;
        g.pids.push(Number(pid));
        groups.set(name, g);
    }
    dir.close();
    return groups;
}

function formatBytes(bytes, perSecond = false) {
    const units = perSecond
        ? [_('B/s'), _('KB/s'), _('MB/s'), _('GB/s')]
        : [_('B'), _('KB'), _('MB'), _('GB'), _('TB')];
    let i = 0;
    while (bytes >= 1000 && i < units.length - 1) {
        bytes /= 1024;
        i++;
    }
    const digits = i === 0 || bytes >= 100 ? 0 : 1;
    return `${bytes.toFixed(digits)} ${units[i]}`;
}

function level(fraction) {
    if (fraction >= 0.9)
        return 'rsx-sysmon-hot';
    if (fraction >= 0.7)
        return 'rsx-sysmon-warm';
    return null;
}

function setLevel(actor, fraction) {
    actor.remove_style_class_name('rsx-sysmon-hot');
    actor.remove_style_class_name('rsx-sysmon-warm');
    const name = level(fraction);
    if (name)
        actor.add_style_class_name(name);
}

// A thin horizontal bar.
class Bar {
    constructor(styleClass = 'rsx-sysmon-bar') {
        this.actor = new St.Widget({style_class: styleClass, x_expand: true});
        this._fill = new St.Widget({style_class: 'rsx-sysmon-bar-fill'});
        this.actor.add_child(this._fill);
        this._fraction = 0;
        this.actor.connect('notify::width', () => this._place());
        this.actor.connect('notify::height', () => this._place());
    }

    set(fraction) {
        this._fraction = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
        setLevel(this._fill, this._fraction);
        this._place();
    }

    _place() {
        this._fill.set_position(0, 0);
        this._fill.set_size(Math.round(this.actor.width * this._fraction), this.actor.height);
    }
}

// CPU and memory over the last two minutes: two lines, CPU in the accent
// color, memory dimmer.
class Graph {
    constructor() {
        this.actor = new St.DrawingArea({style_class: 'rsx-sysmon-graph', x_expand: true});
        this.samples = [];
        this.actor.connect('repaint', () => this._draw());
    }

    push(cpu, mem) {
        this.samples.push({cpu, mem});
        if (this.samples.length > HISTORY)
            this.samples.shift();
    }

    _draw() {
        const cr = this.actor.get_context();
        const [w, h] = this.actor.get_surface_size();
        const node = this.actor.get_theme_node();
        const accent = node.get_foreground_color();
        const rgba = (c, a) => cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, a);
        const white = {red: 255, green: 255, blue: 255};
        const step = w / (HISTORY - 1);
        const pad = 1.5;
        const y = v => pad + (h - 2 * pad) * (1 - Math.max(0, Math.min(1, v)));

        // Guides at 50% and 100%.
        rgba(white, 0.08);
        cr.setLineWidth(1);
        for (const v of [0.5, 1]) {
            cr.moveTo(0, Math.round(y(v)) + 0.5);
            cr.lineTo(w, Math.round(y(v)) + 0.5);
        }
        cr.stroke();

        const n = this.samples.length;
        const x0 = w - (n - 1) * step;
        const line = (key, color, lineAlpha, fillAlpha) => {
            if (n < 2)
                return;
            cr.moveTo(x0, y(this.samples[0][key]));
            this.samples.forEach((p, i) => cr.lineTo(x0 + i * step, y(p[key])));
            rgba(color, lineAlpha);
            cr.setLineWidth(1.5);
            cr.strokePreserve();
            cr.lineTo(w, h);
            cr.lineTo(x0, h);
            cr.closePath();
            rgba(color, fillAlpha);
            cr.fill();
        };
        line('mem', white, 0.45, 0.06);
        line('cpu', accent, 1, 0.22);
        cr.$dispose();
    }
}

function label(text, styleClass, props = {}) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
}

// "Title ............ value" with an optional bar under it.
function statRow(title, withBar = true) {
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'rsx-sysmon-stat'});
    const head = new St.BoxLayout({style_class: 'rsx-sysmon-stat-head'});
    const name = label(title, 'rsx-sysmon-stat-title', {x_expand: true});
    const value = label('', 'rsx-sysmon-stat-value');
    head.add_child(name);
    head.add_child(value);
    box.add_child(head);
    const bar = withBar ? new Bar() : null;
    if (bar)
        box.add_child(bar.actor);
    const sub = label('', 'rsx-sysmon-stat-sub');
    sub.visible = false;
    box.add_child(sub);
    return {actor: box, value, bar, sub};
}

export class SystemMonitor {
    constructor(settings, extension) {
        this._settings = settings;
        this._path = extension.path;
    }

    enable() {
        this._sensor = findCpuSensor();
        this._prevCpu = readCpu();
        this._prevNet = {...readNet(), time: GLib.get_monotonic_time()};
        this._prevProc = null;
        this._prevDisk = {...readDisks(), time: GLib.get_monotonic_time()};
        this._confirm = null;
        this._gpu = null;
        this._gpuMissing = !GLib.find_program_in_path('nvidia-smi');

        this._button = new PanelMenu.Button(0.5, 'rsx system monitor');
        this._button.add_style_class_name('rsx-sysmon-button');
        const box = new St.BoxLayout({style_class: 'rsx-sysmon-panel'});
        this._box = box;
        this._cpuLabel = this._panelItem(box, 'rsx-cpu', _('Processor'));
        this._ramLabel = this._panelItem(box, 'rsx-memory', _('Memory'));
        this._tempLabel = this._panelItem(box, 'rsx-temperature', _('Temperature'));
        // Network: download over upload, two small lines.
        const net = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'rsx-sysmon-item rsx-sysmon-net',
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: _('Network'),
        });
        this._downLabel = label('', 'rsx-sysmon-net-line');
        this._upLabel = label('', 'rsx-sysmon-net-line');
        net.add_child(this._downLabel);
        net.add_child(this._upLabel);
        box.add_child(net);
        this._netItem = net;
        this._tempItem = this._tempLabel.get_parent();
        this._ramItem = this._ramLabel.get_parent();
        this._button.add_child(box);
        this._buildMenu();

        Main.panel.addToStatusArea('rsx-sysmon', this._button, 0, 'right');
        // Tray icons (AppIndicator) also go to the start: stay left of them.
        Main.panel._rightBox.connectObject('child-added', () => this._keepFirst(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._fit(), this);
        this._keepFirst();

        this._settings.connectObject('changed::system-monitor-network',
            () => this._syncNetVisible(), this);
        this._syncNetVisible();

        this._button.menu.connectObject('open-state-changed', (_m, open) => {
            if (open) {
                this._prevProc = null;
                this._update(true);
            } else {
                this._setConfirm(null);
            }
        }, this);

        this._update(false);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, INTERVAL, () => {
            this._update(this._button.menu.isOpen);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // An icon like the other top bar icons, and its number.
    _panelItem(box, icon, name) {
        const item = new St.BoxLayout({
            style_class: 'rsx-sysmon-item',
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: name,
        });
        const gicon = icon.startsWith('rsx-')
            ? Gio.FileIcon.new(Gio.File.new_for_path(`${this._path}/icons/${icon}-symbolic.svg`))
            : Gio.ThemedIcon.new(`${icon}-symbolic`);
        item.add_child(new St.Icon({gicon, style_class: 'system-status-icon rsx-sysmon-icon'}));
        const value = label('', 'rsx-sysmon-value');
        item.add_child(value);
        box.add_child(item);
        return value;
    }

    _keepFirst() {
        const container = this._button?.container;
        const right = Main.panel._rightBox;
        if (container?.get_parent() === right && right.get_child_at_index(0) !== container)
            right.set_child_at_index(container, 0);
    }

    _syncNetVisible() {
        this._fit();
    }

    // Show what fits between the island and the tray: the island sits in
    // the middle of the top bar, so when room runs short the network goes
    // first, then the temperature, then memory. The CPU always stays.
    _fit() {
        const container = this._button?.container;
        if (!container?.get_stage() || container.width <= 0)
            return;
        const wanted = [
            this._ramItem,
            this._sensor ? this._tempItem : null,
            this._settings.get_boolean('system-monitor-network') ? this._netItem : null,
        ].filter(Boolean);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return; // early at startup: no monitors yet
        const [x] = container.get_transformed_position();
        const right = x + container.width;
        const limit = monitor.x + monitor.width / 2 + (COMPACT_MAX_WIDTH / 2 + ISLAND_GAP) * scale;

        const spacing = this._box.layout_manager.spacing;
        const widthOf = a => a.get_preferred_width(-1)[1];
        const shown = this._box.get_children().filter(a => a.visible);
        const frame = container.get_preferred_width(-1)[1] -
            shown.reduce((sum, a) => sum + widthOf(a), 0) - spacing * Math.max(0, shown.length - 1);
        const widthWith = items => frame + widthOf(this._cpuLabel.get_parent()) +
            items.reduce((sum, a) => sum + widthOf(a) + spacing, 0);

        const keep = [...wanted];
        while (keep.length && right - widthWith(keep) < limit)
            keep.pop();
        for (const item of [this._ramItem, this._tempItem, this._netItem])
            item.visible = keep.includes(item);
    }

    _buildMenu() {
        const menu = this._button.menu;
        menu.box.add_style_class_name('rsx-sysmon-menu');
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'rsx-sysmon-content',
        });

        this._cpuStat = statRow(_('Processor'), false);
        this._graph = new Graph();
        this._cpuStat.actor.insert_child_at_index(this._graph.actor, 1);
        const legend = new St.BoxLayout({style_class: 'rsx-sysmon-legend'});
        const key = (text, cls) => {
            const k = new St.BoxLayout({style_class: 'rsx-sysmon-legend-key'});
            k.add_child(new St.Widget({style_class: `rsx-sysmon-legend-dot ${cls}`, y_align: Clutter.ActorAlign.CENTER}));
            k.add_child(label(text, 'rsx-sysmon-stat-sub'));
            return k;
        };
        legend.add_child(key(_('Processor'), 'rsx-sysmon-legend-cpu'));
        legend.add_child(key(_('Memory'), 'rsx-sysmon-legend-mem'));
        legend.add_child(new St.Widget({x_expand: true}));
        legend.add_child(label(_('2 min'), 'rsx-sysmon-stat-sub'));
        this._cpuStat.actor.insert_child_at_index(legend, 2);
        content.add_child(this._cpuStat.actor);

        this._memStat = statRow(_('Memory'));
        content.add_child(this._memStat.actor);

        this._gpuStat = statRow(_('Graphics'));
        this._gpuStat.actor.visible = false;
        content.add_child(this._gpuStat.actor);

        this._diskStat = statRow(_('Disk'));
        content.add_child(this._diskStat.actor);

        this._netStat = statRow(_('Network'), false);
        content.add_child(this._netStat.actor);

        this._procBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'rsx-sysmon-procs',
        });
        this._procBox.add_child(label(_('Using the most CPU'), 'rsx-sysmon-section'));
        this._procRows = [];
        for (let i = 0; i < TOP_PROCESSES; i++) {
            const line = new St.BoxLayout({x_expand: true});
            const name = label('', 'rsx-sysmon-proc-name', {x_expand: true});
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            const mem = label('', 'rsx-sysmon-proc-mem');
            const cpu = label('', 'rsx-sysmon-proc-cpu');
            line.add_child(name);
            line.add_child(mem);
            line.add_child(cpu);
            // A click asks in a dialog, then quits it.
            const row = new St.Button({style_class: 'rsx-sysmon-proc', child: line, x_expand: true, can_focus: true});
            const r = {row, name, mem, cpu, proc: null};
            row.connect('clicked', () => this._onProcessClick(r));
            this._procBox.add_child(row);
            this._procRows.push(r);
        }
        this._procHint = label(_('Click a process to quit it'), 'rsx-sysmon-stat-sub rsx-sysmon-hint');
        this._procBox.add_child(this._procHint);
        content.add_child(this._procBox);

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('rsx-sysmon-item-content');
        item.add_child(content);
        menu.addMenuItem(item);

        const app = MONITOR_APPS.map(id => Shell.AppSystem.get_default().lookup_app(id)).find(a => a);
        if (app) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction(_('Open %s').replace('%s', app.get_name()), () => app.activate());
        }
    }

    _update(detailed) {
        if (Main.sessionMode.isLocked)
            return;

        // CPU
        const cpu = readCpu();
        const usage = cpu.map((c, i) => {
            const p = this._prevCpu[i];
            const total = c.total - (p?.total ?? 0);
            return total > 0 ? (c.busy - (p?.busy ?? 0)) / total : 0;
        });
        const cpuTicks = (cpu[0]?.total ?? 0) - (this._prevCpu[0]?.total ?? 0);
        this._prevCpu = cpu;
        const all = usage[0] ?? 0;
        this._cpuLabel.text = `${Math.round(all * 100)}%`;
        setLevel(this._cpuLabel, all);

        // Memory
        const mem = readMemory();
        const memFraction = mem.total ? mem.used / mem.total : 0;
        this._ramLabel.text = `${Math.round(memFraction * 100)}%`;
        setLevel(this._ramLabel, memFraction);

        // Temperature
        let temp = null;
        if (this._sensor) {
            const raw = Number(read(this._sensor));
            if (Number.isFinite(raw) && raw > 0)
                temp = raw / 1000;
            this._tempLabel.text = temp === null ? '' : `${Math.round(temp)}°`;
            setLevel(this._tempLabel, temp === null ? 0 : (temp - 30) / 70);
        }

        // Network
        const net = readNet();
        const now = GLib.get_monotonic_time();
        const seconds = Math.max(0.001, (now - this._prevNet.time) / 1e6);
        const down = Math.max(0, (net.rx - this._prevNet.rx) / seconds);
        const up = Math.max(0, (net.tx - this._prevNet.tx) / seconds);
        this._prevNet = {...net, time: now};
        this._downLabel.text = `↓ ${formatBytes(down, true)}`;
        this._upLabel.text = `↑ ${formatBytes(up, true)}`;
        this._fit();

        this._graph.push(all, memFraction);
        const disk = readDisks();
        const diskSeconds = Math.max(0.001, (now - this._prevDisk.time) / 1e6);
        const diskRead = Math.max(0, (disk.read - this._prevDisk.read) / diskSeconds);
        const diskWrite = Math.max(0, (disk.written - this._prevDisk.written) / diskSeconds);
        this._prevDisk = {...disk, time: now};

        if (!detailed)
            return;

        const load = read('/proc/loadavg')?.split(' ').slice(0, 3).join('  ') ?? '';
        this._cpuStat.value.text = `${Math.round(all * 100)}%${temp === null ? '' : `  ·  ${Math.round(temp)}°`}`;
        this._cpuStat.sub.text = `${_('Load')}  ${load}`;
        this._cpuStat.sub.visible = !!load;
        this._graph.actor.queue_repaint();

        this._memStat.value.text = `${formatBytes(mem.used)} / ${formatBytes(mem.total)}`;
        this._memStat.bar.set(memFraction);
        this._memStat.sub.visible = mem.swapTotal > 0;
        this._memStat.sub.text = `${_('Swap')}  ${formatBytes(mem.swapUsed)} / ${formatBytes(mem.swapTotal)}`;

        this._netStat.value.text = `↓ ${formatBytes(down, true)}   ↑ ${formatBytes(up, true)}`;

        const space = readSpace();
        this._diskStat.actor.visible = !!space;
        if (space) {
            this._diskStat.value.text = `${formatBytes(space.used)} / ${formatBytes(space.size)}`;
            this._diskStat.bar.set(space.used / space.size);
            this._diskStat.sub.visible = true;
            this._diskStat.sub.text =
                `${_('Read')} ${formatBytes(diskRead, true)}  ·  ${_('Write')} ${formatBytes(diskWrite, true)}`;
        }

        this._updateProcesses(cpuTicks);
        this._updateGpu();
    }

    _updateProcesses(cpuTicks) {
        const procs = readProcesses();
        const prev = this._prevProc;
        this._prevProc = procs;
        const rows = [];
        for (const [name, p] of procs) {
            const before = prev?.get(name);
            const ticks = before ? Math.max(0, p.ticks - before.ticks) : 0;
            rows.push({name, cpu: cpuTicks > 0 ? ticks / cpuTicks : 0, rss: p.rss, pids: p.pids});
        }
        // Until there's a second sample, order by memory.
        rows.sort(prev ? (a, b) => b.cpu - a.cpu || b.rss - a.rss : (a, b) => b.rss - a.rss);
        this._procRows.forEach((r, i) => {
            const p = rows[i];
            r.row.visible = !!p;
            if (!p)
                return;
            r.proc = p;
            r.name.text = p.name;
            r.mem.text = formatBytes(p.rss);
            this._syncRowConfirm(r, prev ? `${(p.cpu * 100).toFixed(1)}%` : '');
        });
    }

    _syncRowConfirm(r, cpuText) {
        const asking = this._confirm?.name === r.proc?.name;
        r.row.remove_style_class_name('rsx-sysmon-proc-confirm');
        r.row.remove_style_class_name('rsx-sysmon-proc-denied');
        if (asking)
            r.row.add_style_class_name('rsx-sysmon-proc-denied');
        r.cpu.text = asking ? _("Can't quit") : cpuText;
        r.cpuText = cpuText;
    }

    _onProcessClick(r) {
        const p = r.proc;
        if (!p)
            return;
        const mine = PROTECTED.has(p.name) ? [] : p.pids.filter(ownedByMe);
        if (!mine.length) {
            // System or someone else's: say so on the row for a moment.
            this._setConfirm({name: p.name, denied: true});
            return;
        }
        this._button.menu.close();
        const count = mine.length;
        confirm({
            title: _('Quit “%s”?').replace('%s', p.name),
            description: (count > 1
                ? _('%d processes will be asked to quit.').replace('%d', count)
                : _('The process will be asked to quit.')) + ' ' + _('Unsaved work may be lost.'),
            action: _('Quit'),
            onConfirm: () => {
                try {
                    Gio.Subprocess.new(['kill', '-TERM', ...mine.map(String)], Gio.SubprocessFlags.STDERR_SILENCE);
                } catch (e) {
                    console.warn(`rsx@rsx: kill: ${e.message}`);
                }
            },
        });
    }

    _setConfirm(confirm) {
        if (this._confirmId)
            GLib.source_remove(this._confirmId);
        this._confirmId = 0;
        this._confirm = confirm;
        if (confirm) {
            this._confirmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIRM_MS, () => {
                this._confirmId = 0;
                this._setConfirm(null);
                return GLib.SOURCE_REMOVE;
            });
        }
        this._procRows.forEach(r => this._syncRowConfirm(r, r.cpuText ?? ''));
    }

    _updateGpu() {
        if (this._gpuMissing || this._gpuBusy)
            return;
        this._gpuBusy = true;
        let proc;
        try {
            proc = Gio.Subprocess.new([
                'nvidia-smi',
                '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name',
                '--format=csv,noheader,nounits',
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            this._gpuMissing = true;
            this._gpuBusy = false;
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            this._gpuBusy = false;
            if (!this._gpuStat)
                return; // disabled meanwhile
            let out = null;
            try {
                [, out] = p.communicate_utf8_finish(res);
            } catch {}
            const v = out?.split('\n')[0]?.split(',').map(s => s.trim());
            if (!v || v.length < 5 || !p.get_successful()) {
                this._gpuStat.actor.visible = false;
                return;
            }
            const [util, used, total, temp, name] = v;
            const MB = 1024 * 1024;
            this._gpuStat.actor.visible = true;
            this._gpuStat.value.text = `${util}%  ·  ${temp}°`;
            this._gpuStat.bar.set(Number(util) / 100);
            this._gpuStat.sub.visible = true;
            this._gpuStat.sub.text =
                `${name.replace(/^NVIDIA (GeForce )?/, '')}  ·  ${_('Video memory')} ${formatBytes(used * MB)} / ${formatBytes(total * MB)}`;
        });
    }

    disable() {
        if (this._confirmId)
            GLib.source_remove(this._confirmId);
        this._confirmId = 0;
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        Main.panel._rightBox.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._button?.menu.disconnectObject(this);
        this._button?.destroy();
        this._button = null;
        this._gpuStat = null;
        this._prevProc = null;
    }
}
