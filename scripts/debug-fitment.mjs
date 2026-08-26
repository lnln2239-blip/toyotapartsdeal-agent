#!/usr/bin/env node
// debug-fitment.mjs (نسخة محسّنة) — يصعد للأعلى من h3 خطوة خطوة
// لين يلقى المستوى اللي فيه "Fits the following Vehicles"، ويتأكد إنه
// لسا يخص قطعة وحدة بس (مو أكثر من قطعة مختلطين مع بعض).

import * as cheerio from 'cheerio';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

const url = 'https://www.toyotapartsdeal.com/oem-toyota-camry-brake_pad_set.html';

const res = await fetch(url, { headers: BROWSER_HEADERS });
const html = await res.text();
const $ = cheerio.load(html);

const firstH3 = $('h3').first();

console.log('===== تصعيد من h3 للأعلى، مستوى بمستوى =====');
let $el = firstH3.parent();
for (let level = 1; level <= 10; level++) {
  if (!$el || !$el.length) {
    console.log(`المستوى ${level}: ما فيه أب أكثر`);
    break;
  }
  const t = $el.text();
  const hasFits = t.includes('Fits the following Vehicles');
  const partNumberCount = (t.match(/Part Number:/g) || []).length;
  const tag = $el.prop('tagName');
  const cls = $el.attr('class') || '';
  console.log(
    `المستوى ${level}: <${tag} class="${cls}"> طول=${t.length} فيه_Fits=${hasFits} عدد_"Part Number:"=${partNumberCount}`
  );
  if (hasFits) {
    console.log('\n--- لقيناه! أول 1500 حرف من هالمستوى ---');
    console.log(JSON.stringify(t.slice(0, 1500)));
    break;
  }
  $el = $el.parent();
}
