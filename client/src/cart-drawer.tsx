import { useEffect, useRef, type ReactNode } from 'react';

export function CartDrawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) { dialog.current?.close(); return; }
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.showModal();
    return () => { document.body.style.overflow = previous; dialog.current?.close(); };
  }, [open]);
  return <dialog className="cart-drawer" ref={dialog} aria-label="Your shopping cart" onCancel={onClose} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <div className="drawer-heading"><strong>Your cart</strong><button type="button" aria-label="Close cart" onClick={onClose}>✕</button></div>
    {open && children}
  </dialog>;
}
