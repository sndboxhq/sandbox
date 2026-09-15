import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./attribution.css";
import "./preferences.css";
import "./qol.css";
import "./expression.css";
import App from "./App";
import { ToastProvider } from "./components/ui/Toast";
import { TooltipProvider } from "./components/ui/Tooltip";
import { AsyncErrorBoundary } from "./components/ui/AsyncErrorBoundary";
import { RuntimeErrorGuard } from "./components/RuntimeErrorGuard";

const root = document.getElementById("root");
if (!root) throw new Error("sndbox could not find its application root.");
createRoot(root).render(<StrictMode><TooltipProvider><ToastProvider><RuntimeErrorGuard/><AsyncErrorBoundary title="sndbox could not start" homeLabel="Reload sndbox" onHome={() => window.location.reload()}><App/></AsyncErrorBoundary></ToastProvider></TooltipProvider></StrictMode>);
