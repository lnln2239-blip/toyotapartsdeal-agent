#!/usr/bin/env node
// discover-all-models.mjs
//
// يفتح الصفحة الرئيسية لـ toyotapartsdeal.com، يطلع منها روابط كل
// موديلات تويوتا (كامري، كورولا، RAV4... كلهم، مو وحد وحد يدوياً)،
// وبعدين يدخل كل موديل ويطلع فئات قطعه ويضيفها كلها لجدول scrape_queue.
//
// هذا يغطي "الشركة كاملة" بأمر وحد، بدل ما تشغّل discover-categories.mjs
// يدوياً لكل موديل لحاله.
//
// استخدام:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/discover-all-models.mjs

import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SOURCE = 'toyotapartsdeal';
const HOME_URL = 'https://www.toyotapartsdeal.com/';
const DELAY_MS = Number(process.env.DELAY_MS || 3000);

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('لازم تحط SUPABASE_URL و SUPABASE_SERVICE_KEY كـ environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`فشل السحب: HTTP ${res.status} على ${url}`);
  return res.text();
}

function guessCategoryFromUrl(url) {
  const m = url.match(/\/oem-toyota-[a-z0-9_]+-([a-z0-9_]+)\.html/i);
  return m ? m[1] : null;
}

// يطلع كل روابط موديلات تويوتا من الصفحة الرئيسية
// (شكلها: https://www.toyotapartsdeal.com/toyota-{model}-parts.html)
async function discoverModels() {
  console.log(`فتح الصفحة الرئيسية: ${HOME_URL}`);
  const html = await fetchHtml(HOME_URL);
  const $ = cheerio.load(html);

  const models = new Map(); // model slug -> url
  $('a[href*="-parts.html"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const abs = new URL(href, HOME_URL).toString();
    const m = abs.match(/\/toyota-([a-z0-9_]+)-parts\.html$/i);
    if (!m) return;
    models.set(m[1], abs);
  });

  return [...models.entries()];
}

// يطلع كل فئات القطع لموديل وحد (نفس منطق discover-categories.mjs)
async function discoverCategoriesForModel(modelUrl) {
  const html = await fetchHtml(modelUrl);
  const $ = cheerio.load(html);

  const links = new Set();
  $('a[href*="/oem-toyota-"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const abs = new URL(href, modelUrl).toString().split('#')[0];
    if (/\/oem-\d{4}-toyota-/.test(abs)) return; // نستبعد روابط "Browse by Year"
    links.add(abs);
  });

  return [...links];
}

async function main() {
  const models = await discoverModels();
  console.log(`لقيت ${models.length} موديل تويوتا.\n`);

  let totalCategories = 0;

  for (const [modelSlug, modelUrl] of models) {
    console.log(`=== موديل: ${modelSlug} ===`);
    try {
      const categoryUrls = await discoverCategoriesForModel(modelUrl);
      console.log(`  → ${categoryUrls.length} فئة قطع`);

      if (categoryUrls.length) {
        const rows = categoryUrls.map((url) => ({
          source: SOURCE,
          category_url: url,
          model: modelSlug,
          category: guessCategoryFromUrl(url),
          status: 'pending'
        }));

        const { error } = await supabase
          .from('scrape_queue')
          .upsert(rows, { onConflict: 'category_url', ignoreDuplicates: true });

        if (error) throw error;
        totalCategories += categoryUrls.length;
      }
    } catch (err) {
      console.error(`  خطأ بموديل ${modelSlug}:`, err.message);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nخلصنا كل الموديلات. إجمالي فئات القطع المضافة: ${totalCategories}`);
}

main().catch((err) => {
  console.error('خطأ عام:', err.message);
  process.exit(1);
});
