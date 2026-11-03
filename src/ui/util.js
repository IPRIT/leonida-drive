// True when some module subscribed to a setting via game.onSetting(key) — otherwise the UI applies a fallback.
export function hasHandler(game, key) { return (game._settingHandlers?.get(key)?.length ?? 0) > 0; }
