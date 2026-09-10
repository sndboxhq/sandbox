export interface PortalActionResult {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
}

export const initialPortalActionResult: PortalActionResult = { status: "idle" };
