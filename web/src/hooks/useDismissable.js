import { useEffect, useRef } from 'react';

// Close-on-outside-click + Escape for popovers/menus/dropdowns. Attach the
// returned ref to the container; `onDismiss` fires on an outside pointerdown or
// Escape while `open`. Replaces fragile onBlur+setTimeout menu-closing (a11y).
export function useDismissable(open, onDismiss) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function onPointer(e) {
      if (ref.current && !ref.current.contains(e.target)) onDismiss();
    }
    function onKey(e) {
      if (e.key === 'Escape') onDismiss();
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onDismiss]);
  return ref;
}
