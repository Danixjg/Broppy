import { NextResponse, type NextRequest } from "next/server";
import { allow } from "../../../lib/visitor-limit";
import { apiOrigin, signupKind, signupMode, signupPath } from "../../../lib/company";

const back = (request: NextRequest, params: Record<string, string>, kind?: ReturnType<typeof signupKind>) => {
  const base = process.env.APP_BASE_URL ?? request.nextUrl.origin;
  const url = new URL(kind ? signupPath(kind) : "/signup", base);
  for (const [name, value] of Object.entries(params)) if (value) url.searchParams.set(name, value);
  // 303 turns the form's POST into a GET of the page.
  return NextResponse.redirect(url, 303);
};

// The page shows fixed wording for each of these, so nothing typed into a link can appear on it as a message.
const reasonFor = (status: number) => status === 400 ? "invalid" : status === 403 ? "code" : status === 409 ? "taken" : status === 429 ? "limit" : "busy";

const text = (data: FormData, name: string, max: number) => String(data.get(name) ?? "").slice(0, max);

export async function POST(request: NextRequest) {
  if (signupMode() !== "on") return back(request, {});
  const origin = apiOrigin();
  const form = await request.formData().catch(() => undefined);
  if (!form) return back(request, { error: "Something went wrong with the form. Please try again." });
  // A form that names neither kind is the enterprise one, as it was before there were two.
  const kind = signupKind(text(form, "kind", 20)) ?? "enterprise";
  const entered = { company: kind === "personal" ? "" : text(form, "company", 60), name: text(form, "name", 80), email: text(form, "email", 254) };
  // Only a program fills this in; people never see it.
  if (text(form, "website", 100)) return back(request, { sent: entered.email }, kind);
  const visitor = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
  // Generous per network: a whole event venue can share one address.
  if (!allow(`signup:${visitor}`, 30, 3_600_000)) return back(request, { ...entered, error: "limit" }, kind);
  if (!origin) return back(request, { ...entered, error: "busy" }, kind);
  try {
    const response = await fetch(new URL("/v1/signup", origin), { method: "POST", redirect: "error", cache: "no-store",
      headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ ...entered, kind, code: text(form, "code", 100) }) });
    if (response.ok) { await response.body?.cancel(); return back(request, { sent: entered.email }, kind); }
    await response.body?.cancel();
    return back(request, { ...entered, error: reasonFor(response.status) }, kind);
  } catch {
    return back(request, { ...entered, error: "busy" }, kind);
  }
}
