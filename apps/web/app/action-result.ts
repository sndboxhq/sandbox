export interface PortalActionResult {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  copyValue?: string;
  copyLabel?: string;
}

export const initialPortalActionResult: PortalActionResult = { status: "idle" };
