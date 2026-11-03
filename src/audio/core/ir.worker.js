// Synthesises reverb impulse responses off the main thread: Mixer's environments (`names`) and any other
// { name, env, seed } items (the radio stations' room reverbs).
import { ENVIRONMENTS, makeIRData, irSeed } from './Mixer.js';

self.onmessage = (e) => {
  const { sr, names = [], items = [] } = e.data;
  const jobs = [...names.map((name) => ({ name, env: ENVIRONMENTS[name], seed: irSeed(name) })), ...items];
  for (const { name, env, seed } of jobs) {
    try {
      const chans = makeIRData(sr, env, seed);
      self.postMessage({ name, chans }, chans.map((c) => c.buffer));
    } catch (err) {
      self.postMessage({ name, error: String(err?.message || err) });
    }
  }
  self.postMessage({ done: true });
};
