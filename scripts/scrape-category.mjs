#!/usr/bin/env node
// scrape-category.mjs
//
// يسحب فئات من جدول scrape_queue (اللي عبّيته بـ discover-categories.mjs)،
// يمشي على صفحاتها (pagination)، يستخرج رقم القطعة + بيانات التوافق،
// يحفظهم في parts_raw، ويحدّث checkpoint بعد كل صفحة على حدة.
//
// شغّله بشكل متكرر (GitHub Actions على جدول، أو يدوياً) — دايماً يكمل من
// وين وقف بدل ما يبدأ من الصفر، حتى لو انقطع بالنص.
//
// آمن للتشغيل المتوازي: تقدر تشغّل عدة نسخ من هالسكربت بنفس اللحظة
// (مثلاً عبر GitHub Actions matrix)، وكل نسخة تمسك فئة مختلفة تلقائياً
// بدون ما تتصادم مع الثانية (شوف tryClaim/claimNextCategory تحت).
//
// استخدام:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/scrape-category.mjs

import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SOURCE = 'toyotapartsdeal';

const DELAY_MS = Number(process.env.DELAY_MS || 3000);
const MAX_RUNTIME_MS = Number(process.env.MAX_RUNTIME_MS || 5 * 60 * 1000);
const MAX_CATEGORIES_PER_RUN = Number(process.env.MAX_CATEGORIES_PER_RUN || 3);
const STALE_LOCK_MS = 3 * 60 * 1000; // لو عامل ما حدّث قفله من 3 دقايق، نعتبره متوقف ونكمل مكانه

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('لازم تحط SUPABASE_URL و SUPABASE_SERVICE_KEY كـ environment variables.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const startedAt = Date.now();

const timeLeft = () => MAX_RUNTIME_MS - (Date.now() - startedAt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// هيدرز تشبه متصفح حقيقي عادي — نفس السبب الموجود بـ discover-categories.mjs.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

async function fetchPage(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} على ${url}`);
  return res.text();
}

// يحلل سطر توافق واحد، مثال:
// "2007-2011 Toyota Camry | LE, SE, XLE | 4 Cyl 2.4L, 4 Cyl 2.5L | 2ARFE, 2AZFE; ACV40L-AEAGKA, ..."
function parseFitmentLine(line) {
  const segments = line.split('|').map((s) => s.trim());
  const [yearsAndModel, trims, engines, codes] = segments;
  const yearMatch = yearsAndModel?.match(/(\d{4})-(\d{4})\s+(.*)/);
  return {
    raw: line,
    year_from: yearMatch ? Number(yearMatch[1]) : null,
    year_to: yearMatch ? Number(yearMatch[2]) : null,
    model_text: yearMatch ? yearMatch[3] : yearsAndModel || null,
    trims: trims ? trims.split(',').map((s) => s.trim()).filter(Boolean) : [],
    engines: engines ? engines.split(',').map((s) => s.trim()).filter(Boolean) : [],
    codes: codes ? codes.split(',').map((s) => s.trim()).filter(Boolean) : []
  };
}

// يستخرج كل القطع من صفحة فئة وحدة.
// ملاحظة مهمة: الحاوية الصح لكل قطعة هي <li class="part-desc-layout">
// (مؤكدة عبر تشخيص فعلي على الموقع) — النص جواها بدون أي أسطر جديدة،
// فكل الحقول (Other Name, Position, Replaces...) والتوافق (Fits the
// following Vehicles) نستخرجها بـ regex مبني على الحدود بين الحقول
// نفسها، مو على أسطر (\n) لأنها غير موجودة أصلاً بالنص المستخرج.
const FIELD_LABELS =
  'Other Name:|Manufacturer Note:|Comment:|Position:|Warranty:|Replaces:|Replaced by:|Fits the following Vehicles:';

function extractField(text, label) {
  const re = new RegExp(`${label}\\s*([\\s\\S]*?)(?=${FIELD_LABELS}|$)`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

// كل توافق يبدأ بـ "YYYY-YYYY" وينتهي عند بداية التوافق الجاي أو نهاية النص
// (مهم لأن أكثر من توافق ممكن يكونون ملزّقين ببعض بدون أي فاصل).
function extractFitmentBlocks(text) {
  const blocks = text.match(/\d{4}-\d{4}[\s\S]*?(?=\d{4}-\d{4}|$)/g) || [];
  return blocks.map((b) => b.trim()).filter(Boolean);
}

function parseCategoryPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const parts = [];

  $('h3').each((_, h3el) => {
    const $h3 = $(h3el);
    const link = $h3.find('a').first();
    if (!link.length) return;

    const partName = link.text().trim();
    const href = link.attr('href');
    if (!href) return;
    const sourceUrl = new URL(href, pageUrl).toString();

    const $container = $h3.closest('li');
    const containerText = $container.text();

    const pnMatch = containerText.match(/Part Number:\s*([A-Z0-9-]{5,})/i);
    const partNumber = pnMatch ? pnMatch[1].trim() : null;
    if (!partNumber) return; // ما نحفظ أي قطعة بدون رقم مؤكد

    const otherNames = extractField(containerText, 'Other Name:');
    const position = extractField(containerText, 'Position:');
    const replaces = extractField(containerText, 'Replaces:');
    const replacedBy = extractField(containerText, 'Replaced by:');

    let fitment = [];
    const fitsIdx = containerText.indexOf('Fits the following Vehicles:');
    if (fitsIdx !== -1) {
      const block = containerText.slice(fitsIdx + 'Fits the following Vehicles:'.length);
      fitment = extractFitmentBlocks(block).map(parseFitmentLine);
    }

    parts.push({
      source: SOURCE,
      part_number: partNumber,
      part_name: partName,
      other_names: otherNames,
      position: position,
      replaces: replaces,
      replaced_by: replacedBy,
      fitment,
      source_url: sourceUrl,
      category_url: pageUrl,
      verified: false
    });
  });

  let nextUrl = null;
  $('a').each((_, el) => {
    const txt = $(el).text().trim().toLowerCase();
    if (txt === 'next' || txt.startsWith('next')) {
      const href = $(el).attr('href');
      if (href) nextUrl = new URL(href, pageUrl).toString();
    }
  });

  return { parts, nextUrl };
}

async function scrapeOneCategory(queueRow) {
  let currentUrl = queueRow.last_page_url || queueRow.category_url;
  let pagesDone = queueRow.pages_done || 0;
  let partsFound = queueRow.parts_found || 0;

  while (currentUrl) {
    if (timeLeft() < 15000) {
      console.log('قربنا نخلص الوقت المسموح لهالتشغيلة — بنحفظ ونوقف هنا، ونكمل المرة الجاية.');
      return 'paused';
    }

    console.log(`سحب: ${currentUrl}`);
    const html = await fetchPage(currentUrl);
    const { parts, nextUrl } = parseCategoryPage(html, currentUrl);

    if (parts.length) {
      const { error } = await supabase
        .from('parts_raw')
        .upsert(parts, { onConflict: 'source,part_number,source_url' });
      if (error) throw error;
    }

    pagesDone += 1;
    partsFound += parts.length;

    // checkpoint بعد كل صفحة — لو انقطع التشغيل هنا، المرة الجاية يبدأ من nextUrl.
    // نحدّث locked_at كل مرة عشان عامل ثاني ما يفتكر إن الفئة متوقفة ويسحبها من تحتنا.
    await supabase
      .from('scrape_queue')
      .update({
        last_page_url: nextUrl,
        pages_done: pagesDone,
        parts_found: partsFound,
        status: nextUrl ? 'in_progress' : 'done',
        locked_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', queueRow.id);

    console.log(`  → ${parts.length} قطعة (صفحة رقم ${pagesDone}، إجمالي ${partsFound})`);

    currentUrl = nextUrl;
    if (currentUrl) await sleep(DELAY_MS);
  }

  return 'done';
}

// يحاول "يمسك" فئة وحدة بشكل آمن حتى لو عدة عمّال (worker) يشتغلون بنفس اللحظة.
// المسك = تحديث الصف بشرط إن حالته لسا زي ما شفناها وقت القراءة (compare-and-swap).
// لو عامل ثاني سبقنا، التحديث ما يأثر على أي صف، فنعرف إننا خسرنا ونجرب المرشح الجاي.
async function tryClaim(row) {
  const nowIso = new Date().toISOString();
  let query = supabase
    .from('scrape_queue')
    .update({ status: 'in_progress', locked_at: nowIso, updated_at: nowIso })
    .eq('id', row.id);

  if (row.status === 'pending') {
    query = query.eq('status', 'pending');
  } else {
    // in_progress: نمسكها بس لو قفلها قديم (يعني ما حد شغال عليها فعلياً الحين)
    const staleBefore = new Date(Date.now() - STALE_LOCK_MS).toISOString();
    query = query.eq('status', 'in_progress').or(`locked_at.is.null,locked_at.lt.${staleBefore}`);
  }

  const { data, error } = await query.select();
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

async function claimNextCategory() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { data: candidates, error } = await supabase
      .from('scrape_queue')
      .select('*')
      .eq('source', SOURCE)
      .in('status', ['pending', 'in_progress'])
      .order('updated_at', { ascending: true })
      .limit(8);

    if (error) throw error;
    if (!candidates.length) return null;

    for (const row of candidates) {
      const claimed = await tryClaim(row);
      if (claimed) return claimed;
    }
    // كل المرشحين مأخوذين من عمّال ثانين هالحين — ننتظر شوي ونعيد المحاولة
    await sleep(500);
  }
  return null;
}

async function main() {
  let processed = 0;

  while (processed < MAX_CATEGORIES_PER_RUN && timeLeft() > 15000) {
    const row = await claimNextCategory();
    if (!row) {
      console.log('ما فيه فئات متاحة الحين — إما خلصت كلها، أو كل الباقي مأخوذ من عمّال ثانين شغالين هالحين.');
      break;
    }

    console.log(`\n=== فئة: ${row.category_url} ===`);
    try {
      const result = await scrapeOneCategory(row);
      console.log(`النتيجة: ${result}`);
    } catch (err) {
      console.error(`خطأ في ${row.category_url}:`, err.message);
      await supabase
        .from('scrape_queue')
        .update({ status: 'error', error_message: err.message })
        .eq('id', row.id);
    }
    processed += 1;
  }
}

main().catch((err) => {
  console.error('خطأ عام:', err.message);
  process.exit(1);
});
