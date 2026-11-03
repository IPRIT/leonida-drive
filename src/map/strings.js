// UI strings of the cartography module (namespace 'carto'). Place names are never translated.
import { CATEGORIES } from './poi.js';

const en = {
  players: 'Other players',
  teleport: 'Teleport',
  setWaypoint: 'Set waypoint',
  clearWaypoint: 'Clear waypoint',
  close: 'Close',
  poi: 'Points of interest',
  all: 'All',
  none: 'None',
  unnamed: 'Unnamed place',
  inspired: 'Real-life inspiration',
  enterable: 'Enterable',
  demolished: 'Demolished',
  unconfirmed: 'Unconfirmed',
  closed: 'Closed',
  safehouse: 'Safehouse',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  locate: 'Centre on me',
  data: 'Data',
  places: '{n} places',
  places_one: '{n} place',
  places_other: '{n} places',
  zoomCluster: 'Click to zoom in',
  you: 'You',
  km: '{n} km',
  m: '{n} m',
  waypoint: 'Waypoint',
  street: 'Street',
  openMarker: 'Open this place on the fan map',
  irl: 'IRL',
  irlTitle: 'Real-world prototype on the fan map',
};
const ru = {
  players: 'Другие игроки',
  teleport: 'Телепорт',
  setWaypoint: 'Поставить метку',
  clearWaypoint: 'Убрать метку',
  close: 'Закрыть',
  poi: 'Интересные места',
  all: 'Все',
  none: 'Ничего',
  unnamed: 'Место без названия',
  inspired: 'Прототип в реальности',
  enterable: 'Можно войти',
  demolished: 'Снесено',
  unconfirmed: 'Не подтверждено',
  closed: 'Закрыто',
  safehouse: 'Убежище',
  zoomIn: 'Приблизить',
  zoomOut: 'Отдалить',
  locate: 'Ко мне',
  data: 'Данные',
  places_one: '{n} место',
  places_few: '{n} места',
  places_many: '{n} мест',
  places_other: '{n} места',
  zoomCluster: 'Нажмите, чтобы приблизить',
  you: 'Вы',
  km: '{n} км',
  m: '{n} м',
  waypoint: 'Метка',
  street: 'Улица',
  openMarker: 'Открыть это место на фан-карте',
  irl: 'IRL',
  irlTitle: 'Прототип в реальности на фан-карте',
};
for (const [id, c] of Object.entries(CATEGORIES)) { en[`cat.${id}`] = c.en; ru[`cat.${id}`] = c.ru; }

export const STRINGS = { en, ru };

// t(key, params): resolves game.i18n lazily (the cartography may be created before the UI creates i18n)
export function makeT(game) {
  let registered = null;
  return (key, params) => {
    const i18n = game?.i18n;
    if (i18n?.register && registered !== i18n) {
      registered = i18n;
      if (!i18n.namespaces?.has?.('carto')) i18n.register('carto', STRINGS);
    }
    const fallback = en[key] ?? key;
    let s = i18n?.t ? i18n.t(`carto.${key}`, { ...(params || {}), default: fallback }) : fallback;
    if (!i18n?.t && params) s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : params[k]));
    return s;
  };
}
