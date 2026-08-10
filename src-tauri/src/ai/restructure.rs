//! AI 智能重排（Prompt 4 §9-14，Phase 1）
//!
//! 把 OpenDataLoader 解析出的杂乱元素序列（断句切碎、页眉页脚残留、标题层级
//! 不全、中英摘要重复）交给 DeepSeek V4 Flash 重排为结构清晰的 Markdown。
//!
//! 关键设计：
//! 1. **防截断分批**：重排输出 ≈ 输入 × 1.5，单批输出受 max_output_tokens
//!    约束（翻译踩过的坑）。按「输入 token 预算」切批，尽量在 heading 边界
//!    切分（保持章节完整性）。
//! 2. **[图N] 编号稳定性**：提示词预置图序清单（论文 N 张图依次 [图1]..[图N]），
//!    前端把 [图N] 映射回 parsed.json 的 figure imageSrc。
//! 3. **文件缓存**：papers/{uuid}/restructured.md；force=false 且已存在 → 直接返回。
//! 4. **幂等锁**：同论文并发只跑一个任务（复用 translate 的模式）。

use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

use super::model_by_id;
use super::translate::call_model;

pub const RESTRUCTURE_PROGRESS_EVENT: &str = "restructure-progress";

const MODEL_ID: &str = "deepseek-v4-flash";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestructuredDoc {
    pub markdown: String,
    pub figure_count: usize,
    pub prompt_tokens: u64,
    pub estimated_cost_usd: f64,
    pub generated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestructureProgress {
    pub stage: String, // prepare | calling | done
    pub percent: u8,
    pub message: String,
}

/// 固定 System Prompt（前缀缓存友好；重排是低频单次操作，缓存价值次要，
/// 正确性优先——图序清单放每批 user 开头）
///
/// 核心原则：**只调整结构，不翻译**。输入是英文论文则输出英文，输入是中文则输出中文。
/// 翻译是「翻译」的独立功能，重排不做。
const SYSTEM_PROMPT: &str = "你是一位学术论文排版专家，只做结构重排，不做翻译。\
将给定的杂乱文本序列重排为结构清晰的 Markdown。要求：\
1) 合并被截断的断句/段落；2) 重建标题层级（#/##/###，最多三级）；3) 中英对照的摘要/关键词只保留一份；\
4) 删除页眉页脚、版权、脚注等残留；\
5) 图片位置输出 [图N] 占位符，表格位置输出 [表N] 占位符（严格按给定清单编号，不得自造编号）；\
6) 公式必须使用标准 LaTeX，并用 $...$（行内）或 $$...$$（独立公式）完整包裹；\
   禁止把 \\frac / \\sqrt / \\sum / \\int / \\tag 等 LaTeX 命令直接裸写在文本里。\
   例：行内 `kh = k q_g / mu` 写作 `$kh = \\frac{k q_g}{\\mu}$`；独立编号公式 `Q_1 = ... \\tag{1}` 写作 `$$Q_1 = ... \\tag{1}$$`。\
7) 参考文献逐条整理；\
8) 逐段重排不得删减任何正文内容，禁止改写、摘要化或幻觉补全；\
9) **绝对不要翻译成其他语言，按原文语言输出（输入是英文就输出英文，是中文就输出中文）**。只输出 Markdown，不要解释。";

/// 抽取的重排输入元素（保留类型/页码/层级，供 prompt 组装）
#[derive(Clone)]
struct Item {
    page: i64,
    kind: String, // paragraph | heading | caption | table | formula | figure
    text: String,
    heading_level: Option<i64>,
}

/// 同论文并发重排互斥锁
static RESTRUCTURE_LOCKS: std::sync::OnceLock<
    std::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::OnceLock::new();

fn lock_for(uuid: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let map = RESTRUCTURE_LOCKS
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let Ok(mut map) = map.lock() else {
        return std::sync::Arc::new(tokio::sync::Mutex::new(()));
    };
    map.entry(uuid.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 从 parsed.json 提取元素序列（按页 + readingOrder 排序）+ 图序/表序清单
fn extract_items_and_assets(parsed: &serde_json::Value) -> (Vec<Item>, Vec<String>, Vec<String>) {
    let mut items: Vec<Item> = Vec::new();
    let mut figures: Vec<String> = Vec::new();
    let mut tables: Vec<String> = Vec::new();

    if let Some(pages) = parsed["pages"].as_array() {
        for page in pages {
            let page_num = page["pageNumber"].as_i64().unwrap_or(0);
            if let Some(elements) = page["elements"].as_array() {
                // 按 readingOrder 排序，保证图序/表序与前端 PDFViewer 一致
                let mut sorted: Vec<&serde_json::Value> = elements.iter().collect();
                sorted.sort_by_key(|el| el["readingOrder"].as_i64().unwrap_or(0));
                for el in sorted {
                    let kind = el["type"].as_str().unwrap_or("paragraph").to_string();
                    let text = el["text"].as_str().unwrap_or("").trim().to_string();
                    if text.is_empty() && kind != "figure" && kind != "table" {
                        continue;
                    }
                    // 图片：登记图序（imageSrc 供前端映射）
                    if kind == "figure" {
                        if let Some(src) = el["imageSrc"].as_str() {
                            if !src.is_empty() {
                                figures.push(src.to_string());
                            }
                        }
                        continue;
                    }
                    // 表格：登记表序，同时保留文本供 AI 理解表格内容
                    if kind == "table" {
                        if let Some(src) = el["imageSrc"].as_str() {
                            if !src.is_empty() {
                                tables.push(src.to_string());
                            }
                        }
                    }
                    items.push(Item {
                        page: page_num,
                        kind,
                        text,
                        heading_level: el["headingLevel"].as_i64(),
                    });
                }
            }
        }
    }
    (items, figures, tables)
}

/// token 估算（复用 translate 的固定系数：中文 1.5、英文 0.3/字符）
fn est_tokens(text: &str) -> usize {
    let cjk = text.chars().filter(|c| {
        let cp = *c as u32;
        (0x4E00..=0x9FFF).contains(&cp) || (0x3400..=0x4DBF).contains(&cp)
    }).count();
    let other = text.chars().count() - cjk;
    (cjk as f64 * 1.5 + other as f64 * 0.3).ceil() as usize
}

/// 按输入 token 预算切批（尽量在 heading 元素边界切，保持章节完整）
fn build_batches(items: Vec<Item>, input_budget: usize) -> Vec<Vec<Item>> {
    let mut batches: Vec<Vec<Item>> = Vec::new();
    let mut cur: Vec<Item> = Vec::new();
    let mut cur_tok = 0usize;

    for item in items {
        let t = est_tokens(&item.text).max(8);
        if !cur.is_empty() && cur_tok + t > input_budget {
            // 当前元素是标题且新批次从这里开始 → 干净切分
            batches.push(std::mem::take(&mut cur));
            cur_tok = 0;
        }
        cur.push(item);
        cur_tok += t;
    }
    if !cur.is_empty() {
        batches.push(cur);
    }
    batches
}

/// 组装单批 user 内容（含图序/表序清单，保证 [图N]/[表N] 编号全局一致）
fn build_batch_content(batch: &[Item], figure_list: &str, table_list: &str) -> String {
    let mut content = String::new();
    content.push_str("【本论文共有图（请严格按此编号输出 [图N] 占位符）】\n");
    content.push_str(figure_list);
    content.push_str("\n\n【本论文共有表（请严格按此编号输出 [表N] 占位符）】\n");
    content.push_str(table_list);
    content.push_str("\n\n【公式】行内公式请用 $...$，独立公式请用 $$...$$。\n");
    content.push_str("\n【待重排文本（按阅读顺序，格式：[类型|页码] 内容）】\n");
    for it in batch {
        let tag = match it.kind.as_str() {
            "heading" => format!("标题{}", it.heading_level.map(|h| format!("(H{h})")).unwrap_or_default()),
            "caption" => "图注".into(),
            "table" => "表格".into(),
            "formula" => "公式".into(),
            _ => "正文".into(),
        };
        content.push_str(&format!("[{tag}|{page}] {text}\n", page = it.page, text = it.text));
    }
    content
}

/// 智能重排论文 → 写 papers/{uuid}/restructured.md
#[tauri::command]
pub async fn ai_restructure(
    app: AppHandle,
    pdf_path: String,
    force: Option<bool>,
) -> Result<RestructuredDoc, String> {
    let force = force.unwrap_or(false);
    let uuid = super::super::pdf_parser::pdf_uuid(&pdf_path);
    let paper_dir = super::super::pdf_parser::papers_dir(&app)?.join(&uuid);
    let md_path = paper_dir.join("restructured.md");
    let hash_path = paper_dir.join("restructured.hash");

    // 1. 先读解析缓存计算 hash（P1-2：缓存失效检测——parsed.json 变化后
    //    旧 restructured.md 必须视为失效，否则展示过期重排结果）
    let parsed_raw = std::fs::read_to_string(paper_dir.join("parsed.json"))
        .map_err(|_| "ERR:PARSE_NOT_FOUND:论文尚未解析，请先打开 PDF".to_string())?;
    let source_hash = super::translate::simple_hash(&parsed_raw);

    // 已有且非强制，且 hash 匹配（parsed.json 未变）→ 直接返回
    // （前端已读缓存时不会走到这里，双保险）
    if !force && md_path.exists() {
        let hash_ok = std::fs::read_to_string(&hash_path)
            .map(|h| h.trim() == source_hash)
            .unwrap_or(false);
        if hash_ok {
            let content = std::fs::read_to_string(&md_path)
                .map_err(|e| format!("读取重排文档失败: {}", e))?;
            return Ok(RestructuredDoc {
                markdown: content,
                figure_count: 0,
                prompt_tokens: 0,
                estimated_cost_usd: 0.0,
                generated_at: String::new(),
            });
        }
        // hash 不匹配 → 旧缓存失效，继续重新生成
    }

    // 同论文并发互斥
    let lock = lock_for(&uuid);
    let _guard = lock.lock().await;

    let emit = |stage: &str, percent: u8, message: String| {
        let _ = app.emit(
            RESTRUCTURE_PROGRESS_EVENT,
            &RestructureProgress { stage: stage.into(), percent, message },
        );
    };
    emit("prepare", 5, "读取解析结果".into());

    let parsed: serde_json::Value = serde_json::from_str(&parsed_raw)
        .map_err(|e| format!("读取解析结果失败: {}", e))?;
    let (items, figures, tables) = extract_items_and_assets(&parsed);
    if items.is_empty() {
        return Err("ERR:NO_CONTENT:论文没有可重排的文本内容".into());
    }

    // 2. 图序/表序清单
    let figure_list = if figures.is_empty() {
        "（本文无图）".to_string()
    } else {
        let mut s = String::new();
        for (i, _) in figures.iter().enumerate() {
            s.push_str(&format!("[图{}]（第{}张） ", i + 1, i + 1));
        }
        s
    };
    let table_list = if tables.is_empty() {
        "（本文无表）".to_string()
    } else {
        let mut s = String::new();
        for (i, _) in tables.iter().enumerate() {
            s.push_str(&format!("[表{}]（第{}个） ", i + 1, i + 1));
        }
        s
    };

    // 3. 分批（防截断：输出≈输入×1.5，取 max_output_tokens 的 85% 反推输入预算）
    let model = model_by_id(MODEL_ID).ok_or_else(|| format!("未知模型: {}", MODEL_ID))?;
    let max_out = model.max_output_tokens.max(2000) as usize;
    let out_budget = (max_out as f64 / 1.5 * 0.85) as usize;
    let input_budget = (out_budget as f64 / 1.5 * 0.9) as usize;
    let batches = build_batches(items, input_budget.max(1500));
    emit(
        "prepare",
        12,
        format!(
            "共 {} 张图、{} 个表，分 {} 批重排",
            figures.len(),
            tables.len(),
            batches.len()
        ),
    );

    // 4. 逐批调用（复用 call_model：SSE 关闭，直接返回全文）
    let mut md_parts: Vec<String> = Vec::new();
    let mut total_prompt: u64 = 0;
    for (idx, batch) in batches.iter().enumerate() {
        emit(
            "calling",
            15 + ((idx as f64 / batches.len() as f64) * 70.0) as u8,
            format!("正在重排第 {}/{} 批（DeepSeek V4 Flash）", idx + 1, batches.len()),
        );
        let content = build_batch_content(batch, &figure_list, &table_list);
        // 与 translate.rs call_model 一致的 tuple 消息格式
        let messages = vec![
            ("system".to_string(), SYSTEM_PROMPT.to_string()),
            ("user".to_string(), content),
        ];
        let (raw, usage) = call_model(MODEL_ID, messages, Some(max_out as u32), Some(0.7)).await?;
        // 截断检测：finish_reason="length" → 该批输出被 max_tokens 硬截断
        if usage.finish_reason == "length" {
            return Err(format!(
                "ERR:RESTRUCTURE_TRUNCATED:第 {}/{} 批输出被截断（finish_reason=length），\
                 建议换输出上限更高的模型或重试",
                idx + 1,
                batches.len()
            ));
        }
        total_prompt += usage.prompt_tokens;
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            return Err(format!("ERR:RESTRUCTURE_EMPTY:第 {} 批返回为空，请重试", idx + 1));
        }
        md_parts.push(trimmed);
    }
    let markdown = md_parts.join("\n\n");

    // 5. 落盘（原子写：tmp + rename，防中断写坏缓存；P2-4）+ hash 文件（P1-2）
    std::fs::create_dir_all(&paper_dir).map_err(|e| e.to_string())?;
    let tmp_path = paper_dir.join("restructured.md.tmp");
    std::fs::write(&tmp_path, &markdown).map_err(|e| format!("写入重排文档失败: {}", e))?;
    std::fs::rename(&tmp_path, &md_path).map_err(|e| format!("保存重排文档失败: {}", e))?;
    std::fs::write(&hash_path, &source_hash).map_err(|e| format!("写入重排校验失败: {}", e))?;

    // 6. 成本（输出按输入 1.5 倍）
    let input_tokens = total_prompt as f64;
    let cost = (input_tokens / 1e6 * model.price_input)
        + (input_tokens * 1.5 / 1e6 * model.price_output);
    emit("done", 100, format!("重排完成（输入 {} tokens，约 ¥{:.3}）", total_prompt, cost * 7.0));

    Ok(RestructuredDoc {
        markdown,
        figure_count: figures.len(),
        prompt_tokens: total_prompt,
        estimated_cost_usd: cost,
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    })
}
