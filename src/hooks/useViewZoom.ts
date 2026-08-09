/**
 * hooks/useViewZoom.ts —— 阅读视图通用缩放（Ctrl + 滚轮）
 *
 * - 以鼠标指针位置为锚点缩放（缩放后指针下的内容保持不动）
 * - min/max 限制（默认 50% ~ 300%）
 * - 缩放方式由调用方决定：
 *   - DOM 视图：给内容容器设 `style={{ zoom }}`（WebView2/Chromium 原生缩放，
 *     文本矢量重排不模糊）
 *   - pdfjs 视图：缩放倍数传给 viewport scale，canvas 重渲染保持清晰
 * - 滚动容器上挂原生 wheel 监听（passive:false 才能 preventDefault 阻止浏览器缩放）
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface ViewZoomOptions {
  min?: number;
  max?: number;
  /** 滚轮灵敏度（exp 指数，越大缩放越快；默认 0.0015） */
  sensitivity?: number;
}

const clampZoom = (z: number, min: number, max: number) =>
  Math.min(max, Math.max(min, z));

export function useViewZoom<T extends HTMLElement = HTMLDivElement>({
  min = 0.5,
  max = 3,
  sensitivity = 0.0015,
}: ViewZoomOptions = {}) {
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const scrollRef = useRef<T | null>(null);

  const setZoom = useCallback(
    (z: number) => {
      const nz = clampZoom(z, min, max);
      zoomRef.current = nz;
      setZoomState(nz);
    },
    [min, max],
  );

  /** 重置缩放比例；返回 true 表示比例确实变了（调用方可顺手重置滚动位置） */
  const resetZoom = useCallback(() => {
    setZoom(1);
  }, [setZoom]);

  // 原生 wheel 监听（passive:false 才能阻止浏览器默认页面缩放）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const old = zoomRef.current;
      const nz = clampZoom(old * Math.exp(-e.deltaY * sensitivity), min, max);
      if (nz === old) return;

      const rect = el.getBoundingClientRect();
      // 指针相对容器视口的位置
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // 指针所在的内容坐标（除以旧 zoom 还原到未缩放坐标系）
      const cx = (el.scrollLeft + px) / old;
      const cy = (el.scrollTop + py) / old;

      setZoom(nz);
      // 布局更新后再恢复滚动位置，保证缩放焦点不漂移
      requestAnimationFrame(() => {
        el.scrollLeft = cx * nz - px;
        el.scrollTop = cy * nz - py;
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom, min, max, sensitivity]);

  /** 重置到 100% 并回到顶部 */
  const handleReset = useCallback(() => {
    resetZoom();
    const el = scrollRef.current;
    if (el) {
      el.scrollTo({ top: 0, left: 0 });
    }
  }, [resetZoom]);

  return { zoom, setZoom, resetZoom, handleReset, scrollRef };
}
