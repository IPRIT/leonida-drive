#!/usr/bin/env node
// Real-browser visual evidence: actual Three.js world + actual Canvas map.
// Requires the dev server on :5317 and the no-save Playwright/Chromium packages.
import fs from 'node:fs';
import path from 'node:path';
import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright';

const OUT = path.resolve('docs/evidence/roads');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.LEONIDA_URL || 'http://127.0.0.1:5317';
const allSites = [
  { id: '01-causeway', name: 'Causeway interchange', x: -2576, z: -2770, height: 390, mpp: 0.46 },
  { id: '02-airport', name: 'Airport district interchange', x: -2949, z: -150, height: 390, mpp: 0.46 },
  { id: '03-keys', name: 'Keys highway interchange', x: -3065, z: 6541, height: 390, mpp: 0.46 },
  // Downtown towers require a steeper, closer pair of obliques to avoid occluding the junction.
  { id: '04-downtown', name: 'Downtown signalised junction', x: -657, z: 68, height: 210, mpp: 0.25, obliqueDistance: 55, obliqueHeight: 520 },
];
const only = process.env.EVIDENCE_SITES?.split(',');
const sites = only ? allSites.filter((site) => only.includes(site.id)) : allSites;
const browser = await playwright.launch({
  executablePath: await chromium.executablePath(), headless: true,
  args: [...chromium.args, '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
};
async function caption(page, title, subtitle) {
  await page.evaluate(({ title, subtitle }) => {
    document.getElementById('evidence-caption')?.remove();
    const el = document.createElement('div');
    el.id = 'evidence-caption';
    el.style.cssText = 'position:fixed;z-index:99999;left:18px;top:16px;padding:10px 14px;border-radius:8px;background:rgba(8,13,20,.88);color:white;font:600 17px/1.35 system-ui,sans-serif;letter-spacing:.01em;box-shadow:0 2px 14px #0006;pointer-events:none';
    el.innerHTML = `${title}<div style="font:400 12px/1.5 ui-monospace,monospace;color:#b8d7e8">${subtitle}</div>`;
    document.body.appendChild(el);
  }, { title, subtitle });
}

try {
  const world = await context.newPage(); watch(world);
  console.log('Loading real 3D world…');
  await world.goto(`${BASE}/lab-world.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await world.waitForFunction(() => window.__leonida?.roads?.edges?.length > 7000, { timeout: 300000 });
  await world.evaluate(() => {
    const g = window.__leonida;
    g.renderer.setAnimationLoop(null);
    g.sky.setTime(12);
    g.render.adapt = () => {}; // fixed evidence resolution, no dynamic-scale changes
  });
  console.log('3D ready:', await world.evaluate(() => ({ loadMs: Math.round(window.__leonida.loadMs), edges: window.__leonida.roads.edges.length })));
  for (const site of sites) {
    const views = [
      { id: 'oblique-se', label: '3D · south-east oblique', dx: site.obliqueDistance || 190, dz: site.obliqueDistance || 190, dy: site.obliqueHeight || 135 },
      { id: 'oblique-nw', label: '3D · north-west oblique', dx: -(site.obliqueDistance || 190), dz: -(site.obliqueDistance || 190), dy: site.obliqueHeight || 135 },
      { id: 'top', label: '3D · orthographic-style top view', top: true },
    ];
    for (const view of views) {
      await world.evaluate(({ site, view }) => {
        const g = window.__leonida, c = g.camera;
        const road = g.roads.nearest(site.x, site.z, 500);
        const y = road?.y || g.terrain.heightAt(site.x, site.z);
        if (view.top) c.position.set(site.x, site.height, site.z + 0.01);
        else c.position.set(site.x + view.dx, y + view.dy, site.z + view.dz);
        c.lookAt(site.x, y, site.z);
        c.fov = 55; c.near = 0.3; c.far = 40000; c.updateProjectionMatrix(); c.updateMatrixWorld();
        g.sky.update(0, { x: site.x, z: site.z });
        g.terrain.update(c, 0); g.water.update(0, c, 0); g.roads.update(0, c);
        g.buildings.update(0, 0, c); g.veg.update(c, 0); g.lamps.update(c, 0, 0);
        g.render.render(); g.render.render();
      }, { site, view });
      await caption(world, `${site.name} — ${view.label}`, `world X ${site.x} · Z ${site.z} · actual WebGL frame`);
      const file = path.join(OUT, `${site.id}-${view.id}.jpg`);
      await world.screenshot({ path: file, type: 'jpeg', quality: 92, timeout: 120000 });
      console.log(path.relative(process.cwd(), file));
    }
  }
  await world.close();

  const map = await context.newPage(); watch(map);
  await map.goto(`${BASE}/lab-map.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await map.waitForFunction(() => window.labView, { timeout: 120000 });
  await map.addStyleTag({ content: '#bar,#stats,#radar,.ldm-zoom{display:none!important}' });
  for (const site of sites) {
    await map.evaluate(({ x, z, mpp }) => window.labView(x, z, mpp), site);
    await caption(map, `${site.name} — vector map`, `world X ${site.x} · Z ${site.z} · ${site.mpp.toFixed(2)} m/px · actual Canvas frame`);
    const file = path.join(OUT, `${site.id}-map.jpg`);
    await map.screenshot({ path: file, type: 'jpeg', quality: 94, timeout: 120000 });
    console.log(path.relative(process.cwd(), file));
  }
  await map.close();
  const previous = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
  const previousErrors = Object.fromEntries((previous.sites || []).map((site) => [site.id, site.errors || []]));
  const manifestSites = allSites.map((site) => sites.includes(site) ? { ...site, errors } : { ...site, errors: previousErrors[site.id] || [] });
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
    source: 'YANIS v17 / map.stateofleonida.net', renderer: 'Actual Three.js WebGL and Cartography Canvas frames',
    viewport: [1440, 900], generatedAt: new Date().toISOString(), sites: manifestSites,
    errors: manifestSites.flatMap((site) => site.errors),
  }, null, 2));
  if (errors.length) console.warn('Browser errors:', errors);
} finally {
  await browser.close();
}
