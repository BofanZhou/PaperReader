/**
 * lib/db.ts —— SQLite 落库模块（Prompt 9/10 数据库前置）
 *
 * 用 tauri-plugin-sql 打开 appDataDir/paperreader.db，启动时建表（附录 Schema 全量），
 * 解析成功后把论文元数据 + 页面元素写入 papers / page_elements 表。
 *
 * 设计：
 * - getDb() 惰性单例：首次调用 load + 建表，之后复用同一连接
 * - initDb() 幂等，App 启动时调用，失败不阻塞 UI（文件缓存仍是主通道）
 * - upsertParsedPaper：解析成功后将结果落库（papers + page_elements，全量覆盖）
 * - listPapers / deletePaper / getSetting / setSetting：供 Prompt 9 设置面板使用
 */
import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import type { ParsedResult } from "./env";

let dbPromise: Promise<Database> | null = null;
let schemaReady: Promise<void> | null = null;

/** 惰性获取 DB 连接（并确保建表完成） */
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:paperreader.db").then((db) => {
      schemaReady = initSchema(db).catch((e) => {
        console.error("[db] 建表失败（文件缓存不受影响）:", e);
      });
      return db;
    });
  }
  return dbPromise;
}

/** 幂等初始化：确保连接 + 表结构就绪（供 App 启动时调用） */
export async function initDb(): Promise<void> {
  const db = await getDb();
  await schemaReady;
  void db;
}

/** 建表：附录 Schema 全量（每条语句一次 execute，sqlx 不支持多语句） */
async function initSchema(db: Database): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS papers (
      id TEXT PRIMARY KEY,
      title TEXT,
      file_path TEXT NOT NULL,
      parsed_json_path TEXT,
      page_count INTEGER,
      source_lang TEXT DEFAULT 'en',
      target_lang TEXT DEFAULT 'zh',
      translation_status TEXT DEFAULT 'pending',
      translation_model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS page_elements (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      element_type TEXT NOT NULL,
      bbox_left REAL, bbox_bottom REAL, bbox_right REAL, bbox_top REAL,
      font TEXT, font_size REAL,
      original_text TEXT,
      translated_text TEXT,
      sentences_json TEXT,
      reading_order INTEGER,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    )`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      element_id TEXT,
      page_number INTEGER NOT NULL,
      start_offset INTEGER, end_offset INTEGER,
      color TEXT DEFAULT '#FFD700',
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    )`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      paper_id TEXT NOT NULL,
      element_id TEXT,
      page_number INTEGER,
      start_offset INTEGER, end_offset INTEGER,
      selected_text TEXT,
      translated_text TEXT,
      content TEXT,
      category TEXT DEFAULT 'insight',
      color TEXT DEFAULT '#FFD700',
      ai_response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    )`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS note_links (
      id TEXT PRIMARY KEY,
      source_note_id TEXT NOT NULL,
      target_note_id TEXT NOT NULL,
      display_text TEXT,
      context TEXT,
      line_number INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_note_id) REFERENCES notes(id) ON DELETE CASCADE
    )`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS unlinked_mentions (
      id TEXT PRIMARY KEY,
      source_note_id TEXT NOT NULL,
      target_note_id TEXT NOT NULL,
      context TEXT,
      is_converted BOOLEAN DEFAULT 0,
      FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_note_id) REFERENCES notes(id) ON DELETE CASCADE
    )`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS terms (
      id TEXT PRIMARY KEY,
      term TEXT NOT NULL UNIQUE,
      translation TEXT NOT NULL,
      definition TEXT,
      domain TEXT,
      source_paper_id TEXT,
      is_user_confirmed BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  );
  await db.execute(
    `CREATE TABLE IF NOT EXISTS translation_progress (
      paper_id TEXT PRIMARY KEY,
      current_chunk INTEGER DEFAULT 0,
      total_chunks INTEGER,
      completed_elements TEXT,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    )`,
  );
  // 索引（Prompt 10 数据库优化基础）
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_elements_paper_page ON page_elements(paper_id, page_number)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_annotations_paper ON annotations(paper_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_notes_paper ON notes(paper_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_notes_category ON notes(category)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_note_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_note_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_terms_domain ON terms(domain)`);
}

/** 论文 uuid（Rust DefaultHasher，与 papers/{uuid} 目录一致） */
export function paperUuid(pdfPath: string): Promise<string> {
  return invoke<string>("get_paper_uuid", { pdfPath });
}

/**
 * 解析成功后落库：papers upsert + page_elements 全量覆盖。
 * 失败只告警（文件缓存仍是主通道），不抛给调用方。
 */
export async function upsertParsedPaper(result: ParsedResult, pdfPath: string): Promise<void> {
  try {
    const uuid = await paperUuid(pdfPath);
    const db = await getDb();
    await schemaReady;

    await db.execute(
      `INSERT INTO papers (id, title, file_path, page_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         page_count = excluded.page_count,
         updated_at = CURRENT_TIMESTAMP`,
      [uuid, result.title, pdfPath, result.pages.length],
    );

    // 覆盖该论文的页面元素（先删后插）
    await db.execute(`DELETE FROM page_elements WHERE paper_id = $1`, [uuid]);

    // 批量插入（每批 200 行拼一条多值 INSERT，避免逐条 IPC）
    const BATCH = 200;
    const rows: unknown[] = [];
    for (const page of result.pages) {
      for (const el of page.elements) {
        rows.push(
          `${uuid}:p${page.pageNumber}:${el.id}`,
          uuid,
          page.pageNumber,
          el.type,
          el.bbox.left,
          el.bbox.bottom,
          el.bbox.right,
          el.bbox.top,
          el.font,
          el.fontSize,
          el.text,
          null, // translated_text
          null, // sentences_json
          el.readingOrder,
        );
        if (rows.length >= BATCH * 14) {
          await insertElementsBatch(db, uuid, rows);
          rows.length = 0;
        }
      }
    }
    if (rows.length > 0) {
      await insertElementsBatch(db, uuid, rows);
    }
  } catch (e) {
    console.error("[db] 解析结果落库失败（文件缓存不受影响）:", e);
  }
}

async function insertElementsBatch(db: Database, _uuid: string, flatRows: unknown[]): Promise<void> {
  const per = 14;
  const n = flatRows.length / per;
  const placeholders = Array.from({ length: n }, () =>
    Array.from({ length: per }, () => "?").join(","),
  ).join("),(");
  await db.execute(
    `INSERT INTO page_elements (
       id, paper_id, page_number, element_type,
       bbox_left, bbox_bottom, bbox_right, bbox_top,
       font, font_size, original_text, translated_text, sentences_json, reading_order
     ) VALUES (${placeholders})`,
    flatRows as never[],
  );
}

// ========== Prompt 9 设置面板 / 存储管理用查询 ==========

export interface PaperRow {
  id: string;
  title: string | null;
  file_path: string;
  page_count: number | null;
  translation_status: string | null;
  created_at: string | null;
}

export async function listPapers(): Promise<PaperRow[]> {
  const db = await getDb();
  await schemaReady;
  return db.select<PaperRow[]>(
    `SELECT id, title, file_path, page_count, translation_status, created_at
     FROM papers ORDER BY created_at DESC`,
  );
}

export async function deletePaper(paperId: string): Promise<void> {
  const db = await getDb();
  await schemaReady;
  await db.execute(`DELETE FROM papers WHERE id = $1`, [paperId]); // ON DELETE CASCADE 连带清理子表
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  await schemaReady;
  const rows = await db.select<{ value: string }[]>(
    `SELECT value FROM settings WHERE key = $1`,
    [key],
  );
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await schemaReady;
  await db.execute(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

// ========== Prompt 10 数据库优化：分页查询 ==========

export interface ElementRow {
  id: string;
  page_number: number;
  element_type: string;
  bbox_left: number | null;
  bbox_bottom: number | null;
  bbox_right: number | null;
  bbox_top: number | null;
  original_text: string | null;
  translated_text: string | null;
  reading_order: number | null;
}

/**
 * 大论文分页查询（Prompt 10 §2：每次查 5 页，配合 idx_elements_paper_page 复合索引）。
 * 返回 [startPage, startPage+pageCount) 范围内的元素，按页/阅读序排列。
 * 注：当前主数据源仍为文件缓存 parsed.json（DB 为旁路），此函数供 P10 后续
 * 将 PDFViewer 数据源迁移到 DB 时使用。
 */
export async function getPaperElementsPaged(
  paperId: string,
  startPage: number,
  pageCount = 5,
): Promise<ElementRow[]> {
  const db = await getDb();
  await schemaReady;
  return db.select<ElementRow[]>(
    `SELECT id, page_number, element_type,
            bbox_left, bbox_bottom, bbox_right, bbox_top,
            original_text, translated_text, reading_order
     FROM page_elements
     WHERE paper_id = $1 AND page_number >= $2 AND page_number < $3
     ORDER BY page_number, reading_order`,
    [paperId, startPage, startPage + pageCount],
  );
}

// ========== Prompt 9 术语库 / 备份 ==========/** 读取全部设置（key → value），供备份导出 */
export async function getAllSettings(): Promise<Record<string, string>> {
  const db = await getDb();
  await schemaReady;
  const rows = await db.select<{ key: string; value: string }[]>(`SELECT key, value FROM settings`);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export interface TermRow {
  term: string;
  translation: string;
  definition: string | null;
  domain: string | null;
}

export async function countTerms(): Promise<number> {
  const db = await getDb();
  await schemaReady;
  const rows = await db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM terms`);
  return rows[0]?.n ?? 0;
}

export async function listTerms(limit = 100): Promise<TermRow[]> {
  const db = await getDb();
  await schemaReady;
  return db.select<TermRow[]>(
    `SELECT term, translation, definition, domain FROM terms ORDER BY term LIMIT $1`,
    [limit],
  );
}

/** 批量导入术语（term 冲突忽略，返回实际新增行数） */
export async function importTerms(
  rows: { term: string; translation: string; definition?: string; domain?: string }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  await schemaReady;
  let inserted = 0;
  for (const r of rows) {
    try {
      const res = await db.execute(
        `INSERT INTO terms (term, translation, definition, domain)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(term) DO NOTHING`,
        [r.term.trim(), r.translation.trim(), r.definition ?? null, r.domain ?? null],
      );
      inserted += res.rowsAffected ?? 0;
    } catch {
      /* 单条失败跳过（脏数据不阻塞整批） */
    }
  }
  return inserted;
}
