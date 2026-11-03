// Device detection for the mobile layer. Pure: pass a fake `env` in tests.
// URL overrides: ?touch=1|0 (force the touch controls on/off), ?mobile=1|0 (force the mobile perf profile).

export function urlFlag(name, env = globalThis) {
  try {
    const v = new URLSearchParams(env.location?.search || '').get(name);
    if (v === '' || v === '1' || v === 'true' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'off') return false;
    return null; // absent or 'auto'
  } catch { return null; }
}

const mq = (env, q) => { try { return !!env.matchMedia?.(q).matches; } catch { return false; } };

/**
 * @returns {{ touch:boolean, coarse:boolean, phone:boolean, tablet:boolean, mobile:boolean, ios:boolean,
 *   iPadOS:boolean, android:boolean, standalone:boolean, lowEnd:boolean, memory:number|null, cores:number|null,
 *   shortSide:number, fullscreenApi:boolean, orientationLock:boolean, reasons:string[] }}
 */
export function detectDevice(env = globalThis) {
  const nav = env.navigator || {};
  const ua = nav.userAgent || '';
  const scr = env.screen || {};
  const reasons = [];
  const maxTouch = nav.maxTouchPoints || 0;
  const touchEvents = 'ontouchstart' in env;
  const coarse = mq(env, '(pointer: coarse)');
  const anyCoarse = coarse || mq(env, '(any-pointer: coarse)');
  const hoverNone = mq(env, '(hover: none)');
  const iPadOS = /Macintosh/.test(ua) && maxTouch > 1; // iPadOS 13+ reports a desktop UA
  const ios = /iPhone|iPad|iPod/.test(ua) || iPadOS;
  const android = /Android/i.test(ua);
  const chMobile = nav.userAgentData?.mobile; // UA client hints (Chromium)
  const uaMobile = chMobile ?? (/Mobi|iPhone|iPod|Android.+Mobile|Opera Mini|IEMobile/i.test(ua));
  const shortSide = Math.min(scr.width || 0, scr.height || 0) || Math.min(env.innerWidth || 0, env.innerHeight || 0);
  const touch = (maxTouch > 0 || touchEvents) && anyCoarse;
  const phone = !!(touch && (uaMobile || (shortSide > 0 && shortSide < 600 && hoverNone)));
  const tablet = !phone && touch && (ios || android || (hoverNone && shortSide < 1100));
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const cores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
  const lowEnd = (memory !== null && memory <= 3) || (cores !== null && cores <= 4);
  const standalone = mq(env, '(display-mode: fullscreen)') || mq(env, '(display-mode: standalone)') || nav.standalone === true;
  const doc = env.document?.documentElement;
  const fullscreenApi = !!(doc && (doc.requestFullscreen || doc.webkitRequestFullscreen)) && !/iPhone|iPod/.test(ua);
  const orientationLock = !!env.screen?.orientation?.lock;
  if (touch) reasons.push(`touch (maxTouchPoints ${maxTouch}, coarse ${coarse ? 'primary' : 'any'})`);
  if (phone) reasons.push(`phone (${chMobile !== undefined ? 'UA-CH mobile' : uaMobile ? 'UA' : 'small screen'}, short side ${shortSide}px)`);
  if (tablet) reasons.push(`tablet (${iPadOS ? 'iPadOS' : ios ? 'iOS' : android ? 'Android' : 'touch-first'}, short side ${shortSide}px)`);
  if (lowEnd) reasons.push(`low-end (${memory ?? '?'} GB, ${cores ?? '?'} cores)`);
  return {
    touch, coarse, phone, tablet, mobile: phone || tablet, ios, iPadOS, android, standalone, lowEnd, memory, cores,
    shortSide, fullscreenApi, orientationLock, reasons,
  };
}
