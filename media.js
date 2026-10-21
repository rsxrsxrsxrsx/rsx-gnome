// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared bits for the dynamic island and the lock screen player: which
// player is "the" player right now, and album covers with rounded corners.

import Gio from 'gi://Gio';
import St from 'gi://St';

// The playing player wins; otherwise the first one that can play.
export function activePlayer(source) {
    const players = source?.players ?? [];
    return players.find(p => p.status === 'Playing') ?? players[0] ?? null;
}

// A square cover. Local files get rounded corners through CSS; remote ones
// (http) go through St.Icon, which can fetch them but can't round corners.
export function coverActor(url, size, radius, styleClass = '') {
    const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
    if (url?.startsWith('file://')) {
        return new St.Bin({
            style_class: styleClass,
            width: size * scaleFactor,
            height: size * scaleFactor,
            style: `background-image: url("${url}");
                    background-size: cover;
                    border-radius: ${radius}px;`,
        });
    }
    if (url) {
        return new St.Icon({
            style_class: styleClass,
            gicon: new Gio.FileIcon({file: Gio.File.new_for_uri(url)}),
            icon_size: size,
        });
    }
    return new St.Icon({
        style_class: `${styleClass} rsx-cover-placeholder`,
        icon_name: 'audio-x-generic-symbolic',
        icon_size: Math.round(size * 0.5),
        width: size * scaleFactor,
        height: size * scaleFactor,
    });
}

export function artistsText(player) {
    return (player?.trackArtists ?? []).join(', ');
}
