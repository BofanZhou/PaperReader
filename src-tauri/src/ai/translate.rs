//! 论文翻译引擎（Prompt 4）
//!
//! 流程：读取 papers/{uuid}/parsed.json → 提取文本元素 → token 估算 →
//! 整篇/分段翻译（分段间做术语上下文注入）→ 解析模型 JSON 返回 →
//! 缓存到 papers/{uuid}/translations_{model}_{lang}.json。
//!
//! 缓存天然支持"中断恢复"：已完成分段的译文已落盘，重跑时跳过命中缓存的元素。
//! （工程补充文档 §2.2 的 SQLite 进度表暂以文件缓存等价实现，Prompt 5 起迁移。）

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

use super::keychain_get;
use crate::pdf_parser::{papers_dir, pdf_uuid};

/// 翻译进度事件名（前端 listen）
pub const TRANSLATE_PROGRESS_EVENT: &str = "translate-progress";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranslateProgress {
    pub done: usize,
    pub total: usize,
    pub message: String,
}

/// 翻译结果（前端用于 translated / bilingual 模式）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResult {
    /// element_id → 译文
    pub translations: HashMap<String, String>,
    pub model_id: String,
    pub target_lang: String,
    pub total_elements: usize,
    pub translated_count: usize,
    pub estimated_cost_usd: f64,
    /// 实际输入 tokens（模型 usage 汇总）
    pub prompt_tokens: u64,
    /// 命中前缀缓存的 tokens（DeepSeek 计费便宜约 10 倍）
    pub cache_hit_tokens: u64,
}

// ========== token 估算（规格 §4：中文≈1.5 tok/字，英文≈1.3 tok/字） ==========

fn is_cjk(ch: char) -> bool {
    let c = ch as u32;
    (0x4E00..=0x9FFF).contains(&c) || (0x3400..=0x4DBF).contains(&c)
}

fn estimate_tokens(text: &str) -> usize {
    let cjk = text.chars().filter(|&c| is_cjk(c)).count();
    let other = text.chars().count().saturating_sub(cjk);
    (cjk as f64 * 1.5 + other as f64 * 0.8) as usize // 英文按 ~0.8 tok/字符（含空格）粗估
}

/// 目标语言 → System Prompt 里的语言描述
fn lang_label(lang: &str) -> &'static str {
    match lang {
        "en" => "English（英文）",
        "ja" => "日本語（日文）",
        _ => "中文（简体）",
    }
}

// ========== 元素提取 ==========

#[derive(Debug, Clone)]
struct TranslateItem {
    element_id: String,
    text: String,
}

fn extract_items(result: &serde_json::Value) -> Vec<TranslateItem> {
    let mut items = Vec::new();
    if let Some(pages) = result["pages"].as_array() {
        for page in pages {
            if let Some(elements) = page["elements"].as_array() {
                for el in elements {
                    let etype = el["type"].as_str().unwrap_or("paragraph");
                    // 只翻译文本型元素；figure(图片)、table(结构化)、formula(公式) 跳过
                    if !matches!(etype, "paragraph" | "heading" | "caption") {
                        continue;
                    }
                    let text = el["text"].as_str().unwrap_or("").trim().to_string();
                    if text.is_empty() || text.len() < 2 {
                        continue;
                    }
                    let element_id = el["id"].as_str().unwrap_or("").to_string();
                    if element_id.is_empty() {
                        continue;
                    }
                    items.push(TranslateItem { element_id, text });
                }
            }
        }
    }
    items
}

// ========== 模型调用（非流式，返回完整文本 + usage） ==========

#[derive(Debug, Default, Clone, Copy)]
struct ModelUsage {
    prompt_tokens: u64,
    cache_hit_tokens: u64,
}

/// 支持多条消息（[system] + [固定 user 前缀] + [每批内容]），
/// 前缀固定 → DeepSeek 前缀缓存命中（价格约 10 倍便宜）。
async fn call_model(
    model_id: &str,
    messages: Vec<(String, String)>,
    max_tokens: Option<u32>,
) -> Result<(String, ModelUsage), String> {
    let model = super::model_by_id(model_id).ok_or_else(|| format!("未知模型: {}", model_id))?;
    let key = keychain_get(&model.provider)?
        .ok_or_else(|| format!("KEY_NOT_SET:{}", model.provider))?;

    let client = reqwest::Client::new();
    let url = format!("{}/chat/completions", model.base_url);
    let body_messages: Vec<serde_json::Value> = messages
        .iter()
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect();
    let mut body = serde_json::json!({
        "model": model.api_model,
        "messages": body_messages,
        "stream": false,
        // 温度按模型配置（Kimi for Coding 强制 1，DeepSeek 用 0.2）
        "temperature": model.temperature,
    });
    // 显式输出上限：不设时服务商用默认值（通常 4096/8192），
    // 大批次译文容易超限被硬截断 → JSON 损坏。
    if let Some(mt) = max_tokens {
        body["max_tokens"] = serde_json::json!(mt);
    }

    let resp = client
        .post(&url)
        .bearer_auth(&key)
        .json(&body)
        .send()
        .await
        .map_err(|e| super::redact(&format!("NETWORK_ERROR:{}", e)))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(super::map_http_error(status.as_u16(), &text));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| super::redact(&format!("解析响应失败: {}", e)))?;
    // 缓存命中字段名各服务略有差异：DeepSeek 用 prompt_cache_hit_tokens，
    // Kimi 等可能用 cache_hit_tokens / prompt_cache_hit_tokens，逐个兼容。
    let u = &json["usage"];
    let usage = ModelUsage {
        prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
        cache_hit_tokens: u["prompt_cache_hit_tokens"]
            .as_u64()
            .or_else(|| u["cache_hit_tokens"].as_u64())
            .unwrap_or(0),
    };
    Ok((super::extract_text(&json), usage))
}

// ========== 译文 JSON 解析（多级容错） ==========
//
// 模型输出形态多变，按优先级逐级容错：
//   A. 完整 JSON 对象：{"paragraphs": [{"element_id", "translated_text"}]}
//   B. 直接键值映射：  {"el_123": "译文", "el_456": "译文"}
//   C. JSON 数组：     [{"element_id", "translated_text"}]
//   D. 截断 JSON：     缺结尾括号时自动补齐再解析
//   E. 兜底：          整体损坏时用扫描器提取所有 "key": "value" 键值对
// id 值兼容字符串/数字（模型常把 id 输出成 123 而非 "123"）。

fn parse_translation_json(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let cleaned = strip_code_fence(raw);
    if cleaned.is_empty() {
        return map;
    }

    // 1. 直接解析
    let mut parsed = serde_json::from_str::<serde_json::Value>(&cleaned).ok();
    // 2. 提取 JSON 对象子串（围栏/前言文字包裹）
    if parsed.is_none() {
        if let Some(s) = find_json_object(&cleaned) {
            parsed = serde_json::from_str::<serde_json::Value>(&s).ok();
        }
    }
    // 3. 截断修复：补全缺失的右括号
    if parsed.is_none() {
        if let Some(s) = repair_truncated_json(&cleaned) {
            parsed = serde_json::from_str::<serde_json::Value>(&s).ok();
        }
    }

    if let Some(v) = parsed {
        // 格式 A / C：paragraphs 数组
        if let Some(paras) = v["paragraphs"].as_array() {
            for p in paras {
                let id = json_str(p.get("element_id"));
                let text = json_str(p.get("translated_text"));
                if let (Some(id), Some(text)) = (id, text) {
                    if !text.is_empty() {
                        map.insert(id, text);
                    }
                }
            }
        }
        // 格式 C：裸数组 [{element_id, translated_text}]
        else if let Some(arr) = v.as_array() {
            for p in arr {
                let id = json_str(p.get("element_id"));
                let text = json_str(p.get("translated_text"));
                if let (Some(id), Some(text)) = (id, text) {
                    if !text.is_empty() {
                        map.insert(id, text);
                    }
                }
            }
        }
        // 格式 B：直接键值映射 {"id": "译文"}
        else if let Some(obj) = v.as_object() {
            for (k, val) in obj {
                if let Some(text) = json_str(Some(val)) {
                    if !text.is_empty() {
                        map.insert(k.clone(), text);
                    }
                }
            }
        }
    }

    // 4. 兜底：整体 JSON 损坏时，扫描所有 "key": "value" 键值对
    if map.is_empty() {
        extract_kv_pairs(&cleaned, &mut map);
    }
    map
}

/// 去掉 ```json ... ``` 围栏
fn strip_code_fence(s: &str) -> String {
    let mut cleaned = s.trim().to_string();
    if cleaned.starts_with("```") {
        if let Some(start) = cleaned.find('\n') {
            cleaned = cleaned[start + 1..].trim().to_string();
        }
        if cleaned.ends_with("```") {
            cleaned = cleaned[..cleaned.len() - 3].trim().to_string();
        }
    }
    cleaned
}

/// 从 JSON 值取标量文本（字符串 / 数字 / 布尔都兼容）
fn json_str(v: Option<&serde_json::Value>) -> Option<String> {
    match v? {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn find_json_object(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    for (i, c) in s[start..].char_indices() {
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(s[start..start + i + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// 截断 JSON 修复：从第一个 { 开始，若到文本末尾括号未闭合，补全缺失的 }。
/// 完整 JSON 返回 None（不需要修复）。
fn repair_truncated_json(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut esc = false;
    for c in s[start..].chars() {
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return None; // 括号完整，无需修复
                }
            }
            _ => {}
        }
    }
    if depth > 0 {
        let mut out = s[start..].trim_end().to_string();
        for _ in 0..depth {
            out.push('}');
        }
        Some(out)
    } else {
        None
    }
}

/// 兜底扫描器：从任意文本中提取所有 "key": "value" 键值对
/// （JSON 整体损坏/截断时也能抢救出部分译文）
fn extract_kv_pairs(s: &str, map: &mut HashMap<String, String>) {
    let bytes = s.as_bytes();
    let n = bytes.len();
    let mut i = 0usize;
    while i < n {
        // 找下一个引号（key 起点）
        let Some(rel) = s[i..].find('"') else { break };
        let q1 = i + rel;
        // key 结束引号
        let Some(rel2) = s[q1 + 1..].find('"') else { break };
        let q2 = q1 + 1 + rel2;
        let key = s[q1 + 1..q2].trim().to_string();
        // 跳过空白，期望冒号
        let mut j = q2 + 1;
        while j < n && (bytes[j] as char).is_whitespace() {
            j += 1;
        }
        if j >= n || bytes[j] != b':' {
            i = q2 + 1;
            continue;
        }
        j += 1;
        while j < n && (bytes[j] as char).is_whitespace() {
            j += 1;
        }
        if j >= n || bytes[j] != b'"' {
            i = q2 + 1;
            continue;
        }
        // 读取 value 字符串（处理转义）
        j += 1;
        let mut val = String::new();
        let mut esc = false;
        let mut closed = false;
        while j < n {
            let c = bytes[j] as char;
            if esc {
                val.push(c);
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                closed = true;
                break;
            } else {
                val.push(c);
            }
            j += 1;
        }
        if closed && !key.is_empty() && !val.is_empty() {
            map.insert(key, val);
        }
        i = if closed { j + 1 } else { q2 + 1 };
    }
}

// ========== 缓存（文件级，等价实现 §2.2 进度恢复） ==========

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationCache {
    /// parsed.json 内容 hash，用于缓存失效
    source_hash: String,
    translations: HashMap<String, String>,
}

fn simple_hash(s: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn cache_path(app: &AppHandle, uuid: &str, model_id: &str, lang: &str) -> Result<std::path::PathBuf, String> {
    Ok(papers_dir(app)?.join(uuid).join(format!("translations_{}_{}.json", model_id, lang)))
}

// ========== 对外命令 ==========

/// 翻译整篇论文。返回 element_id → 译文 映射（含缓存命中部分）。
#[tauri::command]
pub async fn translate_paper(
    app: AppHandle,
    pdf_path: String,
    target_lang: String,
    model_id: String,
) -> Result<TranslateResult, String> {
    let uuid = pdf_uuid(&pdf_path);
    let paper_dir = papers_dir(&app)?.join(&uuid);
    let parsed_path = paper_dir.join("parsed.json");
    let parsed_raw = std::fs::read_to_string(&parsed_path)
        .map_err(|_| "ERR:PARSE_NOT_FOUND:论文尚未解析，请先打开 PDF".to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&parsed_raw).map_err(|e| format!("读取解析结果失败: {}", e))?;

    let lang = if target_lang.is_empty() { "zh".to_string() } else { target_lang };
    let model_id = if model_id.is_empty() { "deepseek-v4-flash".to_string() } else { model_id };

    // 0. 加载已有缓存（未变则复用）
    let source_hash = simple_hash(&parsed_raw);
    let cache_file = cache_path(&app, &uuid, &model_id, &lang)?;
    let mut cached: HashMap<String, String> = std::fs::read_to_string(&cache_file)
        .ok()
        .and_then(|s| serde_json::from_str::<TranslationCache>(&s).ok())
        .filter(|c| c.source_hash == source_hash)
        .map(|c| c.translations)
        .unwrap_or_default();

    // 1. 提取元素
    let items = extract_items(&parsed);
    if items.is_empty() {
        return Err("ERR:NO_TRANSLATABLE:论文没有可翻译的文本元素".into());
    }

    // 2. 过滤已缓存
    let todo: Vec<&TranslateItem> = items.iter().filter(|i| !cached.contains_key(&i.element_id)).collect();
    let emit = |app: &AppHandle, done: usize, total: usize, msg: String| {
        let _ = app.emit(TRANSLATE_PROGRESS_EVENT, &TranslateProgress { done, total, message: msg });
    };

    // 3. token 估算 + 分段
    let model = super::model_by_id(&model_id).ok_or_else(|| format!("未知模型: {}", model_id))?;
    let sys_tokens = 400usize;
    let available = (model.context_window as usize).saturating_sub(sys_tokens + 2000);
    // 关键：分批上限必须受【单次输出上限】约束（译文 ≈ 输入 × 1.5）。
    // 上下文窗口再大（如 DeepSeek 1M），单次输出超 max_output_tokens 也会被
    // 服务商硬截断 → 返回的 JSON 不完整 → TRANSLATE_PARSE。这是截断的主根因。
    let max_out = model.max_output_tokens.max(2000) as usize;
    let out_limited = ((max_out as f64) / 1.5 * 0.9) as usize; // 输出预算的 90%
    let total_tokens: usize = todo.iter().map(|i| estimate_tokens(&i.text)).sum();
    let chunk_tokens = if available > 0 { available.min(out_limited) } else { out_limited };
    let chunks: Vec<Vec<&TranslateItem>> = {
        let mut v = Vec::new();
        let mut cur = Vec::new();
        let mut cur_tok = 0usize;
        // &todo 迭代产生 &&TranslateItem，push 时用 *item 解引用为 &TranslateItem
        for item in &todo {
            let t = estimate_tokens(&item.text).max(10);
            if !cur.is_empty() && cur_tok + t > chunk_tokens {
                v.push(std::mem::take(&mut cur));
                cur_tok = 0;
            }
            cur.push(*item);
            cur_tok += t;
        }
        if !cur.is_empty() {
            v.push(cur);
        }
        v
    };
    let total = todo.len();
    let mut done = items.len() - total; // 已缓存的数量
    emit(&app, done, items.len(), format!("准备翻译（{} 段，{:.1}K tokens，分 {} 批）", total, total_tokens as f64 / 1000.0, chunks.len()));

    // 4. 逐批翻译
    //    DeepSeek 前缀缓存：请求 messages 的公共前缀一致才命中（价格约 10 倍便宜）。
    //    结构 = [system(固定)] + [user(固定说明)] + [user(每批内容)]
    //    → system + 固定说明跨批次/跨论文一致，必然命中；术语上下文放内容末尾不影响前缀。
    //    之前把术语上下文放在 user 开头，每批前缀从第一个字符就 miss → 命中率 0。
    let system = format!(
        "你是一位专业的学术论文翻译专家。把用户给出的论文段落翻译为{lang}。\
         要求：1) 忠实原文，术语翻译专业准确；2) 保留学术语气；3) 每段译文与原文一一对应，\
         不得合并、删减或重新排序；4) 公式、编号、引用标记[1]等原样保留；5) 只输出 JSON，格式：\
         {{\"paragraphs\": [{{\"element_id\": \"...\", \"translated_text\": \"...\"}}]}}，\
         不要输出任何其他文字。",
        lang = lang_label(&lang)
    );
    // 固定 user 前缀：所有批次 / 所有论文 / 同一语言完全一致（前缀缓存命中的关键）
    let fixed_preamble = "请翻译下面给出的论文段落。每段译文必须与原文一一对应，不得合并、删减或重新排序；公式、编号、引用标记[1]等原样保留；只输出 JSON。";
    let mut total_prompt: u64 = 0;
    let mut total_hit: u64 = 0;

    for (idx, chunk) in chunks.iter().enumerate() {
        let mut content = String::new();
        content.push_str("【待翻译段落】\n");
        for item in chunk.iter() {
            content.push_str(&format!("[element_id: {}]\n{}\n\n", item.element_id, item.text));
        }
        // 术语一致性上下文：追加在内容末尾（不破坏前缀），供新批次沿用术语
        if idx > 0 {
            content.push_str("【术语上下文（已翻译的相邻段落，供参考术语译法，无需重复翻译）】\n");
            let ctx: Vec<&String> = cached.values().take(8).collect();
            for t in ctx {
                content.push_str(&format!("{}\n", t));
            }
        }

        let messages = vec![
            ("system".to_string(), system.clone()),
            ("user".to_string(), fixed_preamble.to_string()),
            ("user".to_string(), content),
        ];
        let (raw, usage) = call_model(&model_id, messages, Some(max_out as u32)).await?;
        total_prompt += usage.prompt_tokens;
        total_hit += usage.cache_hit_tokens;
        let parsed_map = parse_translation_json(&raw);
        if parsed_map.is_empty() {
            // 调试：把模型原始返回落盘（覆盖式，下次失败刷新），便于定位格式问题
            let _ = std::fs::write(paper_dir.join("translate_raw_debug.log"), &raw);
            return Err("ERR:TRANSLATE_PARSE:模型返回内容无法解析为译文 JSON，原始返回已保存到 papers 目录 translate_raw_debug.log，请重试".into());
        }
        // 校验：模型可能漏翻部分段落，补上"原文"作为降级（保证不丢内容）
        for item in chunk.iter() {
            let v = parsed_map.get(&item.element_id).cloned().unwrap_or_else(|| item.text.clone());
            cached.insert(item.element_id.clone(), v);
        }
        done += chunk.len();
        emit(&app, done, items.len(), format!("翻译中（{}/{}）", done, items.len()));

        // 每批完成后落盘（中断后可续传）
        let cache = TranslationCache { source_hash: source_hash.clone(), translations: cached.clone() };
        let _ = std::fs::write(&cache_file, serde_json::to_string(&cache).unwrap_or_default());
    }

    // 5. 估算成本（输出按输入的 1.5 倍）
    let input_tokens = total_tokens as f64;
    let output_tokens = input_tokens * 1.5;
    let cost = (input_tokens / 1e6 * model.price_input) + (output_tokens / 1e6 * model.price_output);

    // 6. 最终落盘
    let cache = TranslationCache { source_hash, translations: cached.clone() };
    let _ = std::fs::write(&cache_file, serde_json::to_string(&cache).unwrap_or_default());
    let hit_pct = if total_prompt > 0 {
        total_hit as f64 * 100.0 / total_prompt as f64
    } else {
        0.0
    };
    emit(
        &app,
        items.len(),
        items.len(),
        format!("翻译完成（输入 {} tokens，前缀缓存命中 {:.0}%）", total_prompt, hit_pct),
    );

    Ok(TranslateResult {
        translations: cached,
        model_id,
        target_lang: lang,
        total_elements: items.len(),
        translated_count: items.len(),
        estimated_cost_usd: cost,
        prompt_tokens: total_prompt,
        cache_hit_tokens: total_hit,
    })
}
