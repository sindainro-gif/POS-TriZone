// Supabase Edge Function: owner menambah pengguna & mereset kata sandi dari homebase (menu Pengguna).
// Pasang:  supabase functions deploy pengguna
// SUPABASE_URL, SUPABASE_ANON_KEY, dan SUPABASE_SERVICE_ROLE_KEY disediakan otomatis oleh Supabase.
//
// Pemanggil harus owner yang login (dicek lewat token pemanggil di database). Service role hanya dipakai
// untuk membuat / mengubah akun Supabase Auth setelah pemeriksaan itu.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { GalatPengguna, kelolaPengguna } from "./pengguna.mjs";

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("PENGGUNA_ALLOWED_ORIGIN") ?? "*",
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
  const url = Deno.env.get("SUPABASE_URL")!;
  const opsi = { auth: { persistSession: false, autoRefreshToken: false } };
  const sb = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { ...opsi, global: { headers: { Authorization: auth } } });
  const adm = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, opsi);

  const db = {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      const { data, error } = await sb.rpc(fn, args ?? {});
      if (error) throw new Error(error.message);
      return data;
    },
  };
  const admin = {
    createUser: async ({ email, password }: { email: string; password: string }) => {
      const { data, error } = await adm.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw new Error(error.message);
      return data.user.id;
    },
    updateUserById: async (id: string, attrs: { password: string }) => {
      const { error } = await adm.auth.admin.updateUserById(id, attrs);
      if (error) throw new Error(error.message);
    },
    deleteUser: async (id: string) => {
      const { error } = await adm.auth.admin.deleteUser(id);
      if (error) throw new Error(error.message);
    },
  };

  let permintaan: unknown;
  try {
    permintaan = await req.json();
  } catch {
    return json(400, { error: "Isi permintaan bukan JSON" });
  }
  try {
    return json(200, await kelolaPengguna({ admin, db, permintaan }));
  } catch (err) {
    if (err instanceof GalatPengguna) return json(err.status, { error: err.message });
    return json(500, { error: (err as Error).message });
  }
});
