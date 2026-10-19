#!/usr/bin/env bash
# Starts a nested GNOME Shell window and opens a few apps inside it.
# Usage: ./dev.sh   (close the window to stop)

if [ -z "$DEV_INNER" ]; then
    DEV_INNER=1 exec dbus-run-session -- "$0" "$@"
fi

log=$(mktemp --tmpdir rsx-dev.XXXXXX.log)
MUTTER_DEBUG_DUMMY_MODE_SPECS=${SIZE:-1920x1080} gnome-shell --devkit --wayland 2>&1 | tee "$log" &
shell_pid=$!

# The shell prints its Wayland socket: "Using Wayland display name 'wayland-1'".
for _ in $(seq 100); do
    socket=$(grep -o "Using Wayland display name '[^']*'" "$log" | head -1 | cut -d"'" -f2)
    [ -n "$socket" ] && break
    sleep 0.1
done

if [ -z "$socket" ]; then
    echo "Nested shell socket not found" >&2
    wait $shell_pid
    exit 1
fi
sleep 2

export WAYLAND_DISPLAY=$socket GDK_BACKEND=wayland
gnome-text-editor &>/dev/null &
gnome-calculator &>/dev/null &
nautilus --new-window &>/dev/null &
gnome-clocks &>/dev/null &
ptyxis --new-window &>/dev/null &

wait $shell_pid
rm -f "$log"
