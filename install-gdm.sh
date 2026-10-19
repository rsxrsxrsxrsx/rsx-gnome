#!/bin/bash
# Installs rsx@rsx for the login screen (GDM).
#
#   sudo ./install-gdm.sh              install or update (re-run after changes)
#   sudo ./install-gdm.sh --uninstall  remove it from the login screen
#
# GDM runs as the "gdm" user, which can't see ~/.local, so the extension is
# copied to /usr/share/gnome-shell/extensions. It's enabled for GDM through
# a keyfile in /usr/share/gdm/dconf, which GDM compiles into its defaults on
# every start (/usr/share/gdm/generate-config). On the login screen only the
# "Cupertino login" look runs.
#
# If the login screen ever breaks: Ctrl+Alt+F3, log in, then run
#   sudo ~/.local/share/gnome-shell/extensions/rsx@rsx/install-gdm.sh --uninstall
#   sudo systemctl restart gdm3
set -euo pipefail

UUID=rsx@rsx
SRC=$(cd "$(dirname "$0")" && pwd)
DEST=/usr/share/gnome-shell/extensions/$UUID
KEYFILE=/usr/share/gdm/dconf/95-rsx-settings
GENERATE=/usr/share/gdm/generate-config
GDM_HOME=$(getent passwd gdm | cut -d: -f6)
# The user who ran sudo: their monitor layout is copied to the login screen.
USER_HOME=$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)
USER_MONITORS=$USER_HOME/.config/monitors.xml

if [ "$(id -u)" != 0 ]; then
    echo "Run with sudo: sudo $0 $*" >&2
    exit 1
fi

if [ "${1:-}" = "--uninstall" ]; then
    rm -f "$KEYFILE"
    rm -rf "$DEST"
    for dir in "$GDM_HOME"/.config "$GDM_HOME"/seat*/config; do
        if [ -f "$dir/monitors.xml.rsx-marker" ]; then
            rm -f "$dir/monitors.xml" "$dir/monitors.xml.rsx-marker"
        fi
    done
    "$GENERATE"
    echo "Removed from the login screen. Log out or reboot to see the stock one."
    exit 0
fi

# Copy (fresh each time, so removed files don't linger).
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC"/. "$DEST"/
rm -rf "$DEST/dev.sh" "$DEST/.git" "$DEST/.gitignore"
chown -R root:root "$DEST"
chmod -R u=rwX,go=rX "$DEST"

# Enable it for GDM.
cat > "$KEYFILE" <<EOF
# Added by $UUID (install-gdm.sh). Remove with: sudo install-gdm.sh --uninstall
[org/gnome/shell]
enabled-extensions=['$UUID']
EOF
chmod 644 "$KEYFILE"
"$GENERATE"

# Same monitor layout (order, primary, scale) on the login screen as in
# your session. Newer GDM runs the login screen as a per-seat dynamic user
# whose config lives in $GDM_HOME/seatN/config; older GDM uses gdm's own
# ~/.config. Copy to whichever exist, owned by that directory's owner.
copy_monitors() {
    local dir=$1 owner
    owner=$(stat -c %u:%g "$dir")
    install -o "${owner%:*}" -g "${owner#*:}" -m 644 "$USER_MONITORS" "$dir/monitors.xml"
    echo "copied by rsx@rsx from $USER_MONITORS" > "$dir/monitors.xml.rsx-marker"
    echo "Monitor layout copied to $dir/monitors.xml"
}

if [ -f "$USER_MONITORS" ]; then
    copied=0
    for dir in "$GDM_HOME"/seat*/config; do
        [ -d "$dir" ] || continue
        copy_monitors "$dir"
        copied=1
    done
    if [ "$copied" = 0 ]; then
        install -d -o gdm -g gdm -m 700 "$GDM_HOME/.config"
        copy_monitors "$GDM_HOME/.config"
    fi
else
    echo "No $USER_MONITORS: the login screen keeps its own monitor layout."
fi

echo "Installed to $DEST and enabled for the login screen ($KEYFILE)."
echo "The login screen uses the wallpaper from your last session"
echo "(published to /var/tmp/rsx-login by rsx). Log out to see it."
