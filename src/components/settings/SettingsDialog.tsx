/**
 * components/settings/SettingsDialog.tsx —— 设置面板（Prompt 9）
 *
 * 六个 Tab：
 * - API：模型选择 + 三 Provider Key 管理（含测试连接）
 * - 翻译：默认语言 + 术语注入/句子对齐/本地缓存开关
 * - 显示：主题（明/暗/跟随系统）、字号、行距、对照分栏比例
 * - 存储：论文列表、删除/清理、缓存大小、备份导出/导入
 * - 术语库：基础库下载、CSV/JSON 导入、统计
 * - 环境：组件路径/版本显示、重新检测、安装引导
 * 所有设置持久化到 SQLite settings 表（settingsStore / db.setSetting）。
 */
import { KeyRound, Languages, Monitor, HardDrive, BookMarked, Cpu } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ApiTab } from "./tabs/ApiTab";
import { TranslateTab } from "./tabs/TranslateTab";
import { DisplayTab } from "./tabs/DisplayTab";
import { StorageTab } from "./tabs/StorageTab";
import { TermsTab } from "./tabs/TermsTab";
import { EnvironmentTab } from "./tabs/EnvironmentTab";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(640px,85vh)] max-w-2xl flex-col" data-testid="settings-dialog">
        <DialogHeader className="shrink-0">
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>API、翻译、显示、存储、术语库与环境配置。所有设置持久化到本机 SQLite。</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="api" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="api">
              <KeyRound aria-hidden /> API
            </TabsTrigger>
            <TabsTrigger value="translate">
              <Languages aria-hidden /> 翻译
            </TabsTrigger>
            <TabsTrigger value="display">
              <Monitor aria-hidden /> 显示
            </TabsTrigger>
            <TabsTrigger value="storage">
              <HardDrive aria-hidden /> 存储
            </TabsTrigger>
            <TabsTrigger value="terms">
              <BookMarked aria-hidden /> 术语库
            </TabsTrigger>
            <TabsTrigger value="env">
              <Cpu aria-hidden /> 环境
            </TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <TabsContent value="api" className="mt-3">
              <ApiTab />
            </TabsContent>
            <TabsContent value="translate" className="mt-3">
              <TranslateTab />
            </TabsContent>
            <TabsContent value="display" className="mt-3">
              <DisplayTab />
            </TabsContent>
            <TabsContent value="storage" className="mt-3">
              <StorageTab />
            </TabsContent>
            <TabsContent value="terms" className="mt-3">
              <TermsTab />
            </TabsContent>
            <TabsContent value="env" className="mt-3">
              <EnvironmentTab />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
