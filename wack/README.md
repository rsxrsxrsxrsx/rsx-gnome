# WACK lock screen (vendored)

Copied from "WACK - Sonoma Lockscreen" 2.1.0 by rinzler69-wastaken,
https://github.com/rinzler69-wastaken/wack-sonoma-lockscreen
License: GPL-3.0 (see LICENSE in this folder).

Changes for rsx@rsx:
- wackLock.js is WACK's extension.js turned into a plain class (WackLock)
  that rsx creates when the screen locks and destroys on unlock.
- Settings live in rsx's schema; translations use WACK's own domain.
- Cupertino mode also blurs the wallpaper while the password prompt is open
  (was always sharp): unlockDialogController.js, wallpaperManager.js,
  wackLock.js; PROMPT_BLUR_BRIGHTNESS 1.0 -> 0.85 in constants.js.
- Settings UI: rsx builds its own pages from WACK's groups (no PRO /
  WACK Shell / donation page); the "Unlock Crossfade" row is hidden when
  WACK Shell isn't installed (modeGroup.js). Strings are always shown in
  in the system language via ../i18n.js.
- Lock screen strings go through ../i18n.js (system language).
