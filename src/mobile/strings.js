// UI strings of the mobile layer, registered as i18n namespace 'mobile' (keys: mobile.<key>). English and Russian live
// here; the other locales carry `mobile.<key>` in src/i18n/locales/<code>.js (loaded on demand).
export const MOBILE_STRINGS = {
  en: {
    rotate: 'Rotate your phone', rotateSub: 'Leonida Drive is played in landscape', menu: 'Menu',
    iosTip: 'Tip: Share → Add to Home Screen for full screen',
    tiltOn: 'Tilt steering on: turn the phone like a wheel', tiltDenied: 'Motion access was denied, tilt steering is off',
    tiltNone: 'This device has no motion sensor, tilt steering is off', tiltTap: 'Tap the screen to allow motion access',
    // touch wording of keyboard hints: welcome toast (msg.welcomeSub), online pill (net.holdTab), photo mode (life.photo.hint)
    welcomeSub: '☰ — menu and vehicles · tap the radar — map', tapPlayers: 'Tap — players',
    photoHint: 'Drag to orbit · pinch to zoom · two fingers to move',
  },
  ru: {
    rotate: 'Поверните телефон', rotateSub: 'В Leonida Drive играют в горизонтальной ориентации', menu: 'Меню',
    iosTip: 'Совет: «Поделиться» → «На экран Домой» — и игра откроется на весь экран',
    tiltOn: 'Руль наклоном включён: поворачивайте телефон как руль', tiltDenied: 'Доступ к датчикам движения запрещён, руль наклоном выключен',
    tiltNone: 'На этом устройстве нет датчика движения, руль наклоном выключен', tiltTap: 'Коснитесь экрана, чтобы разрешить доступ к датчикам',
    welcomeSub: '☰ — меню и транспорт · нажмите на радар — карта', tapPlayers: 'Нажмите — игроки',
    photoHint: 'Проведите — облёт · щипок — зум · двумя пальцами — сдвиг',
  },
};
