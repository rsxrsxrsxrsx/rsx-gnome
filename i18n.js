// SPDX-License-Identifier: GPL-3.0-or-later
//
// Translations: the language is picked in rsx's settings ("language": system,
// ru or en). With "system", Russian systems get Russian and everything else
// gets English (the source strings). Call setLanguage() when it changes.
//
// rsx's own strings live in the RU table below. The bundled lock screen
// module ships its own .mo catalogs, which we read directly (so it works
// the same in the shell and in the prefs window).

import GLib from 'gi://GLib';
import Gettext from 'gettext';

const LOCK_DOMAIN = 'wack-lockscreen-clock@rinzler69-wastaken.github.com';

// System languages in priority order, e.g. ['ru_RU.UTF-8', 'ru_RU', 'ru', 'C'].
const SYSTEM = GLib.get_language_names().filter(l => l !== 'C' && l !== 'POSIX');

let choice = 'system';

// 'system', 'ru' or 'en'.
export function setLanguage(language) {
    choice = ['ru', 'en'].includes(language) ? language : 'system';
}

function languages() {
    return choice === 'system' ? SYSTEM : [choice];
}

export function isRussian() {
    return (languages()[0] ?? 'en').startsWith('ru');
}

const RU = {
    // Prefs: pages and groups
    'Desktop': 'Рабочий стол',
    'Lock & Login': 'Блокировка и вход',
    'Window overview': 'Обзор окон',
    'What you see when you press Super': 'То, что видно по клавише Super',
    'Top bar': 'Верхняя панель',
    'Clipboard': 'Буфер обмена',
    'Lock screen': 'Экран блокировки',
    'Look': 'Оформление',
    'Mode & animations': 'Режим и анимации',
    'Display & power': 'Экран и питание',
    'Login screen': 'Экран входа',
    'Other': 'Прочее',

    // Prefs: overview
    'Window captions': 'Подписи окон',
    'Always show the icon and title under every window': 'Всегда показывать иконку и название под каждым окном',
    'Same size windows': 'Окна одного размера',
    'All previews have the same height, rows line up evenly': 'Все миниатюры одной высоты, ряды выстраиваются ровно',
    'Arrange windows yourself': 'Свой порядок окон',
    'Drag a window onto another one to swap places': 'Перетащи окно на другое, чтобы поменять их местами',
    'Spring animation': 'Пружинная анимация',
    'Smooth opening and closing with a light bounce': 'Плавное открытие и закрытие с лёгким отскоком',

    // Prefs: top bar
    'Blurred top bar': 'Размытие панели',
    'Translucent top bar with the wallpaper blurred under it': 'Полупрозрачная панель с размытыми обоями под ней',
    'Blur strength': 'Сила размытия',

    // Prefs: windows
    'Windows': 'Окна',
    'Open in the center': 'Открывать по центру',
    'New windows open in the middle of the screen with the mouse': 'Новые окна открываются посередине экрана, где сейчас мышка',
    'Spring open and close': 'Пружинное открытие и закрытие',
    'Windows grow in with a light bounce and shrink away when closed':
        'Окна появляются с лёгким отскоком и плавно уменьшаются при закрытии',

    // Prefs: appearance
    'macOS-style volume popup': 'Индикатор громкости как в macOS',
    'A square with a big icon and a bar of segments for volume and brightness':
        'Квадрат с большой иконкой и шкалой из делений для громкости и яркости',
    'Appearance': 'Внешний вид',
    'macOS-style Alt+Tab': 'Alt+Tab как в macOS',
    'Big app icons in a row; windows of one app with Alt+`':
        'Крупные иконки приложений в ряд, окна одного приложения — Alt+`',
    'Rounded screen corners': 'Скруглённые углы экрана',
    'Like on a MacBook display': 'Как у экрана MacBook',
    'No world clocks in the calendar': 'Без мировых часов в календаре',
    'Hide the "Add World Clocks…" button': 'Скрыть кнопку «Add World Clocks…»',

    'Dynamic island': 'Динамический остров',
    'A black pill at the top for music and notifications, instead of banners':
        'Чёрная пилюля сверху для музыки и уведомлений вместо баннеров',
    'Little runner': 'Бегущий человечек',
    'Language': 'Язык',
    'Language of rsx: menus, settings, lock screen and the little runner': 'Язык rsx: меню, настройки, экран блокировки и человечек',
    'Same as the system': 'Как в системе',
    'Talks': 'Разговаривает',
    'Speech bubbles, and reminders to drink water, take a break and go to bed': 'Фразы в облачке и напоминания попить воды, размяться и лечь спать',
    'Pranks': 'Проказы',
    'Sometimes drags a window a little': 'Иногда немного утаскивает окно',
    'Sounds': 'Звуки',
    'Voice when hit, dropped or tickled': 'Голос, когда его бьют, роняют или щекочут',
    'Ouch!': 'Ай!',
    'Hey!': 'Эй!',
    'What was that for?!': 'За что?!',
    'That hurts!': 'Больно же!',
    'Put me down!': 'Поставь меня!',
    'Whoa!': 'Ого!',
    'Heeey!': 'Эээй!',
    'Ow…': 'Ой…',
    'My back…': 'Моя спина…',
    'Hi!': 'Привет!',
    'What are you up to?': 'Чем занимаешься?',
    'I\'m watching you 👀': 'Я слежу за тобой 👀',
    'Nice wallpaper': 'Классные обои',
    'Don\'t mind me': 'Я тут просто бегаю',
    'Phew, it\'s hot in here 🥵': 'Фух, жарко тут 🥵',
    'So tired… charge me 🔋': 'Устал… заряди меня 🔋',
    'Haha, that tickles!': 'Хаха, щекотно!',
    'Stop it, haha!': 'Перестань, хаха!',
    'I\'m not talking to you 😤': 'Не разговариваю с тобой 😤',
    'Okay, friends again ❤️': 'Ладно, мир ❤️',
    'You\'ve got a message!': 'Тебе сообщение!',
    'Huh? I wasn\'t sleeping!': 'А? Я не спал!',
    'I\'m up, I\'m up!': 'Встаю, встаю!',
    'Hehe 😈': 'Хе-хе 😈',
    'Time to drink some water 💧': 'Пора попить воды 💧',
    'You\'ve been sitting for 2 hours. Stretch a bit!': 'Ты сидишь уже 2 часа. Разомнись!',
    'It\'s %s already, go to sleep 😴': 'Уже %s, иди спать 😴',
    'Lives on the desktop: runs, waves, can be dragged, thrown and hit with fast clicks': 'Живёт на рабочем столе: бегает, машет рукой, его можно таскать, бросать и бить быстрыми кликами',
    'Shake to find the cursor': 'Найти курсор встряхиванием',
    'Shake the mouse and the pointer grows big for a moment': 'Потряси мышкой, и курсор на секунду станет большим',
    'Now playing': 'Сейчас играет',
    'Big album cover with play controls when music is playing': 'Большая обложка и кнопки управления, когда играет музыка',
    'Greeting': 'Приветствие',
    '"Good morning, Name" above the avatar': '«Доброе утро, Имя» над аватаром',
    'Name in the greeting (empty: from the account)': 'Имя в приветствии (пусто — из учётной записи)',

    // Prefs: keyboard
    'Keyboard': 'Клавиатура',
    'Shortcuts in any layout': 'Сочетания в любой раскладке',
    'Ctrl+C, Ctrl+V, Ctrl+Shift+V and others work in the Russian layout in every app':
        'Ctrl+C, Ctrl+V, Ctrl+Shift+V и другие работают в русской раскладке во всех программах',

    // Prefs: clipboard
    'Clipboard history': 'История буфера обмена',
    'Search copied text and images with a shortcut': 'Поиск по скопированному тексту и картинкам по горячей клавише',
    'Paste right away': 'Сразу вставлять',
    'Paste the picked item into the active window (Ctrl+V, Ctrl+Shift+V in terminals)':
        'После выбора вставлять в активное окно (Ctrl+V, в терминале Ctrl+Shift+V)',
    'How many to keep': 'Сколько хранить',
    'The latest items; older ones are removed': 'Последние записи, старые удаляются',
    'Shortcut (e.g. <Super>v)': 'Горячая клавиша (например <Super>v)',
    'Clear history': 'Очистить историю',
    'Clear': 'Очистить',

    // Prefs: lock & login
    'macOS-style lock screen': 'Экран блокировки в стиле macOS',
    'Clock at the top, avatar and password field at the bottom, blur while typing the password':
        'Часы сверху, аватар и поле пароля снизу, размытие при вводе пароля',
    'English layout': 'Английская раскладка',
    'Switch to English when locking, back to the previous layout after unlocking':
        'При блокировке включать английскую, после разблокировки возвращать прежнюю',
    'Smoke under the mouse': 'Дым за мышкой',
    'Colourful smoke follows the pointer on the lock and login screens': 'Цветной дым тянется за курсором на экране блокировки и входа',
    'macOS-style login screen': 'Экран входа в стиле macOS',
    'Your wallpaper, clock and avatars, like on the lock screen': 'Ваши обои, часы и аватары как на экране блокировки',
    'System install': 'Установка в систему',
    'The login screen uses a copy of rsx: after changes run': 'Экран входа берёт копию rsx: после изменений запустите',
    'Clear look cache': 'Очистить кэш оформления',
    'Removes temporary data used for the wallpaper and colour matching. It is rebuilt automatically.':
        'Удаляет временные данные для обоев и подстройки цвета. Они создадутся заново автоматически.',
    'Look cache cleared': 'Кэш оформления очищен',
    "Couldn't clear the cache:": 'Не удалось очистить кэш:',

    // Lock screen greeting
    'Good morning': 'Доброе утро',
    'Good afternoon': 'Добрый день',
    'Good evening': 'Добрый вечер',
    'Good night': 'Доброй ночи',

    // Clipboard popup
    'Search the clipboard': 'Поиск в буфере обмена',
    '↑↓ select   ↵ paste   Del remove   Esc close': '↑↓ выбрать   ↵ вставить   Del удалить   Esc закрыть',
    'Nothing found': 'Ничего не найдено',
    'History is empty. Copy something': 'История пуста. Скопируйте что-нибудь',
    'Image': 'Изображение',
    'now': 'сейчас',
    '%d min': '%d мин',
    '%d h': '%d ч',
    '%d d': '%d д',
    '%d B': '%d Б',
    '%d KB': '%d КБ',
    '%s MB': '%s МБ',
};

// rsx's own strings.
export function _(str) {
    return isRussian() ? (RU[str] ?? str) : str;
}

// Same, with a single %d / %s placeholder.
export function _f(str, value) {
    return _(str).replace(/%[ds]/, value);
}

// Parse a GNU .mo file into Map(msgid -> msgstr). Plural entries map their
// singular msgid to the first form.
function loadMo(path) {
    const map = new Map();
    let bytes;
    try {
        [, bytes] = GLib.file_get_contents(path);
    } catch {
        return map;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = view.getUint32(0, true) === 0x950412de;
    if (!le && view.getUint32(0, false) !== 0x950412de)
        return map;

    const count = view.getUint32(8, le);
    const origTable = view.getUint32(12, le);
    const transTable = view.getUint32(16, le);
    const decoder = new TextDecoder();
    const str = (table, i) => {
        const len = view.getUint32(table + i * 8, le);
        const off = view.getUint32(table + i * 8 + 4, le);
        return decoder.decode(bytes.subarray(off, off + len));
    };
    for (let i = 0; i < count; i++) {
        const id = str(origTable, i).split('\0')[0];
        const tr = str(transTable, i).split('\0')[0];
        if (id && tr)
            map.set(id, tr);
    }
    return map;
}

// Lock screen strings that mention the separate "WACK Shell" add-on, which
// rsx doesn't use: never show them.
const LOCK_HIDDEN = new Set([
    'Requires WACK Shell to be installed and enabled.',
    'Requires WACK Shell to be enabled.',
]);

// The first catalog found for the current languages (cached per file).
const catalogs = new Map();
function catalog(pathFor) {
    for (const lang of languages()) {
        const code = lang.split('.')[0].split('@')[0];
        if (code.startsWith('en'))
            return null; // English is the source language
        for (const path of pathFor(code)) {
            if (!catalogs.has(path))
                catalogs.set(path, GLib.file_test(path, GLib.FileTest.EXISTS) ? loadMo(path) : null);
            if (catalogs.get(path))
                return catalogs.get(path);
        }
    }
    return null;
}

// Translator for the bundled lock screen module, in rsx's language.
export function lockTranslator(extensionPath) {
    const pathFor = code => [`${extensionPath}/wack/locale/${code}/LC_MESSAGES/${LOCK_DOMAIN}.mo`];
    return str => (LOCK_HIDDEN.has(str) ? '' : catalog(pathFor)?.get(str) ?? str);
}

// GNOME Shell's own strings (e.g. "Click or press a key to unlock"), in
// rsx's language: the system's own catalog, or the installed one for the
// picked language.
export function shellTranslator() {
    const domain = Gettext.domain('gnome-shell');
    const pathFor = code => ['/usr/share/locale', '/usr/share/locale-langpack']
        .map(dir => `${dir}/${code}/LC_MESSAGES/gnome-shell.mo`);
    return str => {
        if (choice === 'system')
            return domain.gettext(str);
        return catalog(pathFor)?.get(str) ?? str;
    };
}
