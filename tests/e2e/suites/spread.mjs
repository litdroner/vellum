// Two-page spread reading in the real app, on a five-page document (an odd count): the view bar's
// Two-page spread button lays pages out side by side (1–2, 3–4, then 5 alone) and back, staying on the
// same page each way; Previous / Next turn whole spreads and stop at the first and last one, even zoomed
// in; the thumbnails follow the current page; fit width and fit page fit the pair; single-page view shows
// one spread at a time; and the file itself never changes.

import fs from 'node:fs';
import crypto from 'node:crypto';

export const files = { spread: 'multipage' };

export async function run(t) {
  const { c, q, check, sleep, shot, V, settled, waitFor, area } = t;
  const DOC = t.file('spread');
  const v = V(DOC);
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(DOC)).digest('hex');
  const original = hash();
  // The view bar is centred on the document, so it moves while the sidebar opens: click once it has stopped.
  const clickAt = async (expr) => {
    const at = () => q(`(() => { const r = (${expr}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    let [x, y] = await at();
    for (let i = 0; i < 20; i++) {
      await sleep(60);
      const [nx, ny] = await at();
      if (Math.abs(nx - x) < 0.5 && Math.abs(ny - y) < 0.5) break;
      [x, y] = [nx, ny];
    }
    await c.mouse(x, y);
  };
  const page = () => q(`${v}.state.pageNumber`);
  const spreads = () => q(`[...${v}.viewerEl.querySelectorAll('.spread')].map((s) => [...s.querySelectorAll('.page')].map((p) => Number(p.dataset.pageNumber)).join('-')).join(' ')`);
  const activeThumb = () => q(`Number(document.querySelector('.thumbs .thumb.active')?.dataset.page ?? 0)`);
  const bar = '__vellum.ui.viewbar';
  const turn = async (which) => { await clickAt(`${bar}.${which}Btn`); await sleep(350); };

  await waitFor(settled(DOC), 25000);
  const errorsBefore = await q(`__vellum.errors?.length ?? 0`);
  await q(`__vellum.ui.sidebar.showPages()`);
  await waitFor(`document.querySelectorAll('.thumbs .thumb').length === 5`, 8000);
  await q(`${v}.zoomTo('page-width')`);
  const singleWidthScale = await q(`${v}.state.scale`);
  await q(`${v}.goToPage(3)`);
  await sleep(300);

  area('switch on');
  check('the view bar has a Two-page spread button, not pressed', await q(`${bar}.spreadBtn.getAttribute('aria-pressed') === 'false' && !${bar}.spreadBtn.hidden`));
  await clickAt(`${bar}.spreadBtn`);
  check('the button turns spreads on', await waitFor(`${v}.state.spread === true && ${bar}.spreadBtn.getAttribute('aria-pressed') === 'true'`, 3000));
  await sleep(400);
  check('pages pair up 1–2, 3–4, and page 5 is alone', (await spreads()) === '1-2 3-4 5', await spreads());
  const pair = await q(`(() => { const r = (n) => ${v}.viewerEl.querySelector('.page[data-page-number="' + n + '"]').getBoundingClientRect(); const a = r(3), b = r(4); return { sameRow: Math.abs(a.top - b.top) < 2, leftFirst: a.right <= b.left + 1 }; })()`);
  check('pages 3 and 4 sit side by side, 3 on the left', pair.sameRow && pair.leftFirst, JSON.stringify(pair));
  check('the current page is still 3', (await page()) === 3, await page());
  check('the thumbnails still mark page 3', (await activeThumb()) === 3, await activeThumb());

  area('zoom');
  const spreadWidthScale = await q(`${v}.state.scale`);
  check('fit width refits to the pair, about half the single-page scale', spreadWidthScale < singleWidthScale * 0.6 && spreadWidthScale > singleWidthScale * 0.4, `${spreadWidthScale} vs ${singleWidthScale}`);
  const fits = await q(`(() => { const s = ${v}.viewerEl.querySelector('.page[data-page-number="3"]').parentElement.getBoundingClientRect(); const c = ${v}.container; return s.width <= c.clientWidth + 1; })()`);
  check('the whole spread fits the window width', fits);
  await clickAt(`${bar}.fitPageBtn`);
  await sleep(400);
  const fitPage = await q(`(() => { const c = ${v}.container.getBoundingClientRect(); const a = ${v}.viewerEl.querySelector('.page[data-page-number="3"]').getBoundingClientRect(); const b = ${v}.viewerEl.querySelector('.page[data-page-number="4"]').getBoundingClientRect(); return { value: ${v}.state.scaleValue, inside: a.left >= c.left && b.right <= c.right && a.height <= c.height }; })()`);
  check('fit page shows the whole pair', fitPage.value === 'page-fit' && fitPage.inside, JSON.stringify(fitPage));
  check('still on page 3 after refitting', (await page()) === 3, await page());
  await shot('spread-fit-page');

  area('navigation');
  await turn('next');
  check('Next goes to the last spread, page 5 alone', (await page()) === 5, await page());
  check('Next is disabled on the last spread', await q(`${bar}.nextBtn.disabled`));
  check('the thumbnails follow to page 5', await waitFor(`Number(document.querySelector('.thumbs .thumb.active')?.dataset.page) === 5`, 2000), await activeThumb());
  await turn('prev');
  check('Previous goes back to page 3', (await page()) === 3, await page());
  await turn('prev');
  check('Previous goes to page 1', (await page()) === 1, await page());
  check('Previous is disabled on the first spread', await q(`${bar}.prevBtn.disabled`));
  await q(`${v}.zoomTo(3)`);
  await sleep(500);
  await turn('next');
  check('zoomed in, Next still turns a whole spread (1 → 3)', (await page()) === 3, await page());
  await q(`${v}.goToPage(4)`);
  await sleep(300);
  await turn('next');
  check('from the right-hand page 4, Next goes to 5', (await page()) === 5, await page());
  await q(`${v}.zoomTo('page-fit')`);
  await sleep(300);

  area('single-page view');
  await clickAt(`${bar}.singleBtn`);
  await sleep(400);
  await q(`${v}.goToPage(1)`);
  await sleep(300);
  const shown = await q(`[...${v}.viewerEl.querySelectorAll('.page')].filter((p) => p.offsetParent !== null && p.getBoundingClientRect().width > 0).map((p) => Number(p.dataset.pageNumber)).join('-')`);
  check('single-page view shows one spread at a time', shown === '1-2', shown);
  await turn('next');
  check('Next turns to spread 3–4', (await page()) === 3, await page());
  await clickAt(`${bar}.continuousBtn`);
  await sleep(400);
  check('back in continuous scroll, still on page 3 in spreads', (await page()) === 3 && (await spreads()) === '1-2 3-4 5', `${await page()} ${await spreads()}`);

  area('switch off');
  await clickAt(`${bar}.spreadBtn`);
  check('the button turns spreads off', await waitFor(`${v}.state.spread === false && ${bar}.spreadBtn.getAttribute('aria-pressed') === 'false'`, 3000));
  await sleep(400);
  check('no spreads remain', (await spreads()) === '');
  check('still on page 3', (await page()) === 3, await page());
  await turn('next');
  check('Next turns one page again (3 → 4)', (await page()) === 4, await page());
  check('the thumbnails mark page 4', await waitFor(`Number(document.querySelector('.thumbs .thumb.active')?.dataset.page) === 4`, 2000), await activeThumb());

  area('document');
  check('the layout never marks the document changed', await q(`!${v}.state.dirty`));
  check('the file is unchanged', hash() === original);
  check('no errors', (await q(`__vellum.errors?.length ?? 0`)) === errorsBefore, JSON.stringify(await q(`__vellum.errors`)));
}
