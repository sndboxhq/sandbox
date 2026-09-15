import { Newspaper } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useToast } from "./ui/Toast";

export const LATEST_NEWS_URL = "https://sndbox.app/news";

export function LatestNewsButton({ collapsed = false }: { collapsed?: boolean }) {
  const [opening, setOpening] = useState(false);
  const toast = useToast();

  const openLatestNews = async () => {
    if (opening) return;
    setOpening(true);
    try {
      await openUrl(LATEST_NEWS_URL);
    } catch {
      toast.push(
        "sndbox could not open Latest News. Visit sndbox.app/news in your browser.",
        "error",
      );
    } finally {
      setOpening(false);
    }
  };

  return (
    <button
      type="button"
      aria-label="Latest News"
      disabled={opening}
      onClick={() => void openLatestNews()}
    >
      <Newspaper aria-hidden="true" size={16} />
      {!collapsed && <span>{opening ? "Opening Latest News\u2026" : "Latest News"}</span>}
    </button>
  );
}
