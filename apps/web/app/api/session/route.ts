import { auth0 } from "../../../lib/auth0";
export async function GET() {
  const session = await auth0.getSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ user: { name: session.user.name, email: session.user.email } }, { headers: { "cache-control": "no-store" } });
}
