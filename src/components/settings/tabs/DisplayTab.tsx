/**
 * settings/tabs/DisplayTab.tsx —— 显示设置（Prompt 9 §6）
 * 主题（明/暗/跟随系统）、阅读字体大小（12-24px）、行距（1.0-2.0）、
 * 对照模式分栏比例。全部持久化到 SQLite settings 表（settingsStore）。
 */
import { useSettingsStore } from "../../../store/settingsStore";

function SliderRow({
  label,
  hint,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary/60 p-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-fg-tertiary">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-accent"
      />
      <p className="mt-1 text-xs text-fg-tertiary">{hint}</p>
    </div>
  );
}

const THEME_OPTIONS = [
  { id: "light", label: "明亮" },
  { id: "dark", label: "暗黑" },
  { id: "system", label: "跟随系统" },
] as const;

export function DisplayTab() {
  const { themeMode, setThemeMode, fontSize, setFontSize, lineHeight, setLineHeight, splitRatio, setSplitRatio } =
    useSettingsStore();

  return (
    <div className="space-y-4">
      {/* 主题 */}
      <section>
        <h3 className="mb-2 text-sm font-medium">主题</h3>
        <div className="inline-flex rounded-lg bg-bg-tertiary p-0.5">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setThemeMode(o.id)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                themeMode === o.id ? "bg-bg text-fg shadow-sm" : "text-fg-secondary hover:text-fg"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-fg-tertiary">选择"跟随系统"时将自动匹配操作系统明暗偏好。</p>
      </section>

      {/* 阅读字号 */}
      <SliderRow
        label="阅读字体大小"
        hint="作用于 ODL 原文与 AI 重排正文的阅读字号"
        min={12}
        max={24}
        step={1}
        value={fontSize}
        display={`${fontSize}px`}
        onChange={setFontSize}
      />

      {/* 行距 */}
      <SliderRow
        label="行距"
        hint="正文行高倍率，越大越稀疏"
        min={1}
        max={2}
        step={0.1}
        value={lineHeight}
        display={`${lineHeight.toFixed(1)}×`}
        onChange={setLineHeight}
      />

      {/* 对照分栏比例 */}
      <SliderRow
        label="对照模式分栏比例"
        hint="对照视图左栏（原文）宽度占比"
        min={0.3}
        max={0.7}
        step={0.05}
        value={splitRatio}
        display={`${Math.round(splitRatio * 100)}% / ${Math.round((1 - splitRatio) * 100)}%`}
        onChange={setSplitRatio}
      />
    </div>
  );
}
