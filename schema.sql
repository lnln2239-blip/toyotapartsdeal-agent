-- شغّل هذا الملف مرة وحدة في Supabase SQL Editor قبل أول تشغيل للسكربتات.
--
-- لو كنت شغّلته قبل (عندك الجداول أصلاً) وتبي تضيف بس دعم التشغيل المتوازي،
-- يكفي تشغّل هالسطر وحده بدل الملف كامل:
--   alter table scrape_queue add column if not exists locked_at timestamptz;

-- 1) قائمة الانتظار: كل صف = فئة قطع وحدة (مثلاً "Camry / Engine Mount")
--    last_page_url هو الـ checkpoint: وين وصلنا آخر مرة داخل هالفئة.
create table if not exists scrape_queue (
  id bigint generated always as identity primary key,
  source text not null,                 -- مثلاً 'toyotapartsdeal'
  category_url text not null unique,    -- رابط أول صفحة بالفئة
  model text,
  category text,
  status text not null default 'pending',  -- pending | in_progress | done | error
  last_page_url text,                   -- checkpoint: رابط الصفحة الجاية اللي نكمل منها
  pages_done int default 0,
  parts_found int default 0,
  error_message text,
  locked_at timestamptz,                -- وقت آخر عامل مسكها (يمنع تصادم العمّال المتوازيين)
  updated_at timestamptz default now()
);

create index if not exists idx_queue_status on scrape_queue(source, status);

-- 2) القطع الخام المسحوبة — قبل المراجعة والاعتماد
create table if not exists parts_raw (
  id bigint generated always as identity primary key,
  source text not null,
  part_number text not null,
  part_name text,
  other_names text,
  position text,
  replaces text,
  replaced_by text,
  fitment jsonb,               -- مصفوفة توافقات: [{year_from, year_to, model_text, trims[], engines[], codes[]}]
  source_url text,
  category_url text,
  verified boolean not null default false,   -- ما يصير true إلا بعد مراجعتك
  scraped_at timestamptz default now(),
  unique (source, part_number, source_url)
);

create index if not exists idx_parts_raw_verified on parts_raw(verified);
create index if not exists idx_parts_raw_part_number on parts_raw(part_number);
