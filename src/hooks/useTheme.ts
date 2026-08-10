import { useEffect, useState } from "react";
import { useSettingsStore } from "../store/settingsStore";

export type Theme = "light" | "dark";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

/**
 * 明暗主题 hook（Prompt 9：支持 明/暗/跟随系统 三态）。
 * - themeMode 存 SQLite settings（settingsStore），system 模式跟随系统偏好实时切换
 * - 返回 resolved theme（实际生效的 light/dark）+ toggleTheme（保持旧接口兼容）
 */
export function useTheme() {
  const themeMode = useSettingsStore((s) => s.themeMode);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // 监听系统主题变化（system 模式实时跟随）
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const theme: Theme = themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = () =>
    useSettingsStore.getState().setThemeMode(theme === "dark" ? "light" : "dark");

  return { theme, toggleTheme };
}
