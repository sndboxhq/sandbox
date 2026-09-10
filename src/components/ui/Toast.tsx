import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "info";
interface ToastAction { label: string; onAction: () => void }
interface ToastItem { id: string; kind: ToastKind; message: string; action?: ToastAction }
export interface ToastApi { push: (message: string, kind?: ToastKind, action?: ToastAction) => void }
const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const acted = useRef(new Set<string>());
  const remove = useCallback((id: string) => setItems(current => current.filter(item => item.id !== id)), []);
  const push = useCallback((message: string, kind: ToastKind = "info", action?: ToastAction) => {
    const id = crypto.randomUUID();
    setItems(current => [...current.slice(-3), { id, kind, message, action }]);
    window.setTimeout(() => remove(id), kind === "error" ? 8000 : 4500);
  }, [remove]);
  const runAction = useCallback((item: ToastItem) => {
    if (!item.action || acted.current.has(item.id)) return;
    acted.current.add(item.id);
    remove(item.id);
    item.action.onAction();
  }, [remove]);
  const value = useMemo(() => ({ push }), [push]);
  return <ToastContext.Provider value={value}>{children}<div className="toast-region" aria-live="polite" aria-relevant="additions">
    {items.map(item => <div key={item.id} className={`toast toast-${item.kind}`} role={item.kind === "error" ? "alert" : "status"}>
      {item.kind === "success" ? <CheckCircle2 size={16}/> : item.kind === "error" ? <AlertCircle size={16}/> : <Info size={16}/>}
      <span>{item.message}</span>{item.action && <button className="toast-action" onClick={() => runAction(item)}>{item.action.label}</button>}<button aria-label="Dismiss notification" onClick={() => remove(item.id)}><X size={14}/></button>
    </div>)}
  </div></ToastContext.Provider>;
}

export const useToast = () => useContext(ToastContext);
