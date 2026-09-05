import { useRef } from 'react';

/**
 * Pointer handlers that fire `onLongPress` after `ms` of holding still.
 * The returned `consumed()` lets a click handler ignore the click that
 * follows a long press.
 */
export function useLongPress(onLongPress: () => void, ms = 450) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return {
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        fired.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          onLongPress();
        }, ms);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!start.current) return;
        if (Math.abs(e.clientX - start.current.x) > 10 || Math.abs(e.clientY - start.current.y) > 10) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
    consumed: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}
