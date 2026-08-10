/**
 * settings/tabs/TranslateTab.tsx —— 翻译设置（Prompt 9 §5）
 * 默认源/目标语言、术语预注入、句子对齐、本地缓存开关。
 * 持久化到 SQLite settings 表（settingsStore）。
 */
import { useSettingsStore } from "../../../store/settingsStore";

const LANGUAGES = [
  { id: "en", label: "英语 (English)" },
  { id: "zh", label: "中文 (简体)" },
  { id: "ja", label: "日语 (日本語)" },
  { id: "ko", label: "韩语 (한국어)" },
  { id: "fr", label: "法语 (Français)" },
  { id: "de", label: "德语 (Deutsch)" },
  { id: "es", label: "西班牙语 (Español)" },
  { id: "ru", label: "俄语 (Русский)" },
];

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-bg-secondary/60 p-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-fg-tertiary">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? "bg-accent" : "bg-bg-tertiary"
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

export function TranslateTab() {
  const {
    sourceLang,
    targetLang,
    setSourceLang,
    setTargetLang,
    termInjection,
    setTermInjection,
    sentenceAlign,
    setSentenceAlign,
    localCache,
    setLocalCache,
  } = useSettingsStore();

  return (
    <div className="space-y-4">
      <section className="space-y-3">
        <h3 className="text-sm font-medium">默认语言</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs text-fg-tertiary">源语言</span>
            <select
              value={sourceLang}
              onChange={(e) => setSourceLang(e.target.value)}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-fg-tertiary">目标语言</span>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
            >
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-fg-tertiary">用于翻译时的默认语言（工具栏翻译按钮仍使用当前选择的目标语言）。</p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium">翻译选项</h3>
        <Toggle
          label="术语预注入"
          hint="翻译时注入术语库中的专业术语对照，保证术语翻译一致"
          checked={termInjection}
          onChange={setTermInjection}
        />
        <Toggle
          label="句子对齐"
          hint="翻译结果按句对齐（需要模型额外返回对齐信息，开启后译文视图支持逐句对照）"
          checked={sentenceAlign}
          onChange={setSentenceAlign}
        />
        <Toggle
          label="本地缓存"
          hint="启用后重复翻译同一段内容直接使用缓存结果，节省 Token 并支持中断恢复"
          checked={localCache}
          onChange={setLocalCache}
        />
      </section>
    </div>
  );
}
