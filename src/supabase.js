// supabase.js — 인증 클라이언트 + 토큰 포함 fetch. 키는 .env(VITE_*)에서 주입.
// ★anon key만 프론트에 노출(공개 안전). service_role key는 절대 프론트에 두지 않는다.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

// 키 미설정이면 null — UI가 "인증 미설정" 안내(개발 중 키 없이도 빌드는 됨).
export const supabase = url && anon ? createClient(url, anon) : null;
export const authReady = Boolean(supabase);

// ★보호 API 호출 — 현재 세션의 access_token을 Authorization 헤더로. 백엔드가 JWT 검증.
export async function authedFetch(path, opts = {}) {
  let token = null;
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    token = data?.session?.access_token || null;
  }
  const headers = { ...(opts.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return fetch(path, { ...opts, headers });
}
