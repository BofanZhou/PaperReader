import { MessageSquareText, Library, StickyNote, Network } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ChatSidebar } from "../chat/ChatSidebar";
import { useAppStore } from "../../store/appStore";

function EmptyState({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-fg-tertiary [&_svg]:size-10">{icon}</div>
      <div>
        <p className="text-sm font-medium text-fg-secondary">{title}</p>
        <p className="mt-1 text-xs text-fg-tertiary">{desc}</p>
      </div>
    </div>
  );
}

/** 侧边栏：四个标签页（AI解答 / 术语库 / 笔记 / 知识图谱），标签受控便于外部跳转 */
export function Sidebar() {
  const sidebarTab = useAppStore((s) => s.sidebarTab);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);

  return (
    <Tabs value={sidebarTab} onValueChange={(v) => setSidebarTab(v as typeof sidebarTab)} className="flex h-full flex-col">
      <TabsList className="mx-2 mt-2 flex h-9 justify-between gap-1">
        <TabsTrigger value="ai" className="flex-1">
          <MessageSquareText /> AI解答
        </TabsTrigger>
        <TabsTrigger value="terms" className="flex-1">
          <Library /> 术语库
        </TabsTrigger>
        <TabsTrigger value="notes" className="flex-1">
          <StickyNote /> 笔记
        </TabsTrigger>
        <TabsTrigger value="graph" className="flex-1">
          <Network /> 图谱
        </TabsTrigger>
      </TabsList>

      <TabsContent value="ai" className="min-h-0 flex-1">
        <ChatSidebar />
      </TabsContent>
      <TabsContent value="terms">
        <EmptyState
          icon={<Library />}
          title="术语库"
          desc="AI 自动提取术语，支持语义检索（下一步实现）"
        />
      </TabsContent>
      <TabsContent value="notes">
        <EmptyState
          icon={<StickyNote />}
          title="笔记"
          desc="高亮笔记 6 种分类，双向导航到 PDF（下一步实现）"
        />
      </TabsContent>
      <TabsContent value="graph">
        <EmptyState
          icon={<Network />}
          title="知识图谱"
          desc="论文 / 笔记 / 术语的力导向关系图（后续版本）"
        />
      </TabsContent>
    </Tabs>
  );
}
