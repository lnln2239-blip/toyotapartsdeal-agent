#!/usr/bin/env node
// discover-categories.mjs
//
// يفتح صفحة فهرس الموديل (مثال: toyota-camry-parts.html)، يستخرج كل روابط
// فئات القطع (engine_mount, brake_pad, ...) ويضيفها لجدول scrape_queue
// في Supabase عشان scrape-category.mjs يسحبها وحدة وحدة بعدين.
//
// استخدام:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/discover-categories.mjs https://www.toyotapartsdeal.com/toyota-camry-parts.html

import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SOURCE = 'toyotapartsdeal';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('لازم تحط SUPABASE_URL و SUPABASE_SERVICE_KEY كـ environment variables.');
  process.exit(1);
}

const modelIndexUrl = process.argv[2];
if (!modelIndexUrl) {
  console.error('استخدام: node scripts/discover-categories.mjs <رابط-صفحة-الموديل>');
  console.error('مثال:    node scripts/discover-categories.mjs https://www.toyotapartsdeal.com/toyota-camry-parts.html');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function guessModelFromUrl(url) {
  const m = url.match(/toyota-([a-z0-9-]+)-parts\.html/i);
  return m ? m[1] : null;
}

function guessCategoryFromUrl(url) {
  const m = url.match(/\/oem-toyota-[a-z0-9-]+-([a-z0-9_]+)\.html/i);
  return m ? m[1] : null;
}

// هيدرز تشبه متصفح حقيقي عادي — بعض المواقع ترفض الطلبات اللي تعلن
// عن نفسها كبوت (زي "PartsResearchBot") حتى لو الصفحة عامة بالأصل.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

async function main() {
  console.log(`فتح صفحة الفهرس: ${modelIndexUrl}`);
  const res = await fetch(modelIndexUrl, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`فشل السحب: HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // روابط فئات القطع تكون بصيغة: /oem-toyota-{model}-{category}.html
  const links = new Set();
  $('a[href*="/oem-toyota-"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const abs = new URL(href, modelIndexUrl).toString().split('#')[0];
    // نستبعد روابط "Browse by Year" (فيها سنة قبل toyota، مثل oem-2024-toyota-camry-...)
    if (/\/oem-\d{4}-toyota-/.test(abs)) return;
    links.add(abs);
  });

  console.log(`لقيت ${links.size} فئة قطع محتملة.`);

  if (!links.size) {
    console.warn('ما لقيت أي رابط فئات — تأكد إن الرابط صحيح، أو راجع الـ selector لأن الموقع غيّر هيكلته.');
    return;
  }

  const model = guessModelFromUrl(modelIndexUrl);
  const rows = [...links].map((url) => ({
    source: SOURCE,
    category_url: url,
    model,
    category: guessCategoryFromUrl(url),
    status: 'pending'
  }));

  const { error } = await supabase
    .from('scrape_queue')
    .upsert(rows, { onConflict: 'category_url', ignoreDuplicates: true });

  if (error) throw error;
  console.log(`تمت إضافة الفئات لجدول scrape_queue (source=${SOURCE}, model=${model}).`);
}

main().catch((err) => {
  console.error('خطأ:', err.message);
  process.exit(1);
});
