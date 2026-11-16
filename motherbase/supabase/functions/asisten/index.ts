// Supabase Edge Function: asisten AI mother base.
// Pasang:  supabase secrets set ANTHROPIC_API_KEY=...   lalu   supabase functions deploy asisten
// SUPABASE_URL dan SUPABASE_ANON_KEY disediakan otomatis oleh Supabase.
//
// Permintaan dibawa dengan token pengguna yang login (Authorization: Bearer ...), jadi semua
// data dibaca dengan hak pengguna itu (Row Level Security tetap berlaku).
import Anthropic from "npm:@anthropic-ai/sdk@1.4.0";
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { dbDariSupabase, jalankanAsisten } from "./asisten.mjs";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("ASISTEN_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Hanya POST" });

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "Silakan login" });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(500, { error: "ANTHROPIC_API_KEY belum diisi di Supabase (supabase secrets set)" });
  const anthropic = new Anthropic({ apiKey });

  let permintaan: unknown;
  try {
    permintaan = await req.json();
  } catch {
    return json(400, { error: "Isi permintaan bukan JSON" });
  }

  try {
    const hasil = await jalankanAsisten({ anthropic, db: dbDariSupabase(sb), permintaan });
    return json(200, hasil);
  } catch (err) {
    // Kesalahan Claude API: dari yang paling spesifik
    if (err instanceof Anthropic.AuthenticationError) return json(502, { error: "API key Anthropic tidak valid" });
    if (err instanceof Anthropic.RateLimitError) return json(429, { error: "Asisten sedang sibuk, coba lagi sebentar" });
    if (err instanceof Anthropic.BadRequestError) return json(502, { error: `Permintaan ke Claude ditolak: ${err.message}` });
    if (err instanceof Anthropic.APIError) return json(502, { error: `Claude API error ${err.status ?? ""}: ${err.message}` });
    const status = (err as { status?: number }).status;
    return json(status && status >= 400 && status < 500 ? status : 500, { error: (err as Error).message });
  }
});
