import React, { useState, useEffect, useRef } from "react";
import { MapContainer, TileLayer, CircleMarker, Marker, useMapEvents, useMap } from "react-leaflet";
import { supabase, authReady, authedFetch } from "./supabase";
import { MapPin, Map as MapIcon, FileText, KeyRound, ShieldCheck, ArrowRight, Heart } from "lucide-react";

const SEOUL = [37.55, 126.99];
// ★색 = 재개발 환경 유사도 백분위. 빨강(높음=재개발된 동네와 닮음) → 초록(낮음=거리 멂).
const color = (pct) => `hsl(${(1 - pct) * 120}, 80%, 45%)`;
// 유사도 등급(백분위 → 높음/중간/낮음). rank_top_pct: 작을수록 상위(닮음).
const simGrade = (pct) => (pct == null ? null : pct <= 33 ? "높음" : pct <= 66 ? "중간" : "낮음");

// ★렌더 절제: 화면 영역(bbox) 필지만 — moveend마다 /screen/bbox 조회. 점 색으로 환경 유사도 표현.
// ★군집 외곽선(점선)은 제거 — 볼록껍질이 도로·공원을 가로질러 '재개발 구역 경계'로 오독 위험(근거 약함).
function BboxLayer() {
  const [pts, setPts] = useState([]);
  const timerRef = useRef(null);      // 디바운스 타이머
  const abortRef = useRef(null);      // 진행 중 요청(이전 것 취소용 — race 방지)
  const fetchBbox = async (map) => {
    const b = map.getBounds();
    if (map.getZoom() < 13) { setPts([]); return; } // 줌 낮으면 생략(통짜 렌더 금지)
    const q = `west=${b.getWest()}&south=${b.getSouth()}&east=${b.getEast()}&north=${b.getNorth()}&limit=1500`;
    abortRef.current?.abort();                       // ★이전 요청 취소 → 늦은 응답이 최신 결과 덮어쓰기 방지
    const ac = new AbortController();
    abortRef.current = ac;
    // ★/report·/screen과 동일하게 authedFetch로 Bearer 토큰 부착(401 해소). signal은 opts로 그대로 전달됨.
    // authedFetch엔 공통 401 처리가 없어 — 토큰 만료/취소/실패 시 조용히 색점만 미표시(앱 안 죽게).
    try {
      const r = await authedFetch(`/screen/bbox?${q}`, { signal: ac.signal });
      if (!r.ok) return;
      const d = await r.json();
      if (!ac.signal.aborted) setPts(d.results || []);   // 취소된 응답은 버림(stale 방지)
    } catch { /* abort·네트워크·인증 실패 — 무시 */ }
  };
  // ★moveend 400ms 디바운스 — 빠른 드래그/줌 연타 시 마지막 1회만 요청.
  const scheduleFetch = (map) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchBbox(map), 400);
  };
  const map = useMapEvents({ moveend: () => scheduleFetch(map) });
  useEffect(() => () => {                             // 언마운트 정리: 타이머·진행 요청 취소
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
  }, []);
  // 줌아웃 시 백엔드가 점수 무관 균등 샘플로 솎음(분포 보존) → 색 인상 줌 일관. 각 점=필지 환경 유사도.
  return pts.map((p) => (
    <CircleMarker key={p.pnu} center={[p.lat, p.lon]} radius={4}
      pathOptions={{ color: color(p.score_pct), fillOpacity: 0.6, weight: 0 }} />
  ));
}

function FlyTo({ pos }) {
  const map = useMap();
  if (pos) map.flyTo(pos, 16);
  return null;
}

// 5종 판단 섹션 — 아이콘·부제(위계). LLM/템플릿 본문의 '### 라벨'과 매칭.
const SECTION_META = {
  "될까": { ic: "🏘️", sub: "사업 환경" }, "얼마": { ic: "💰", sub: "시세·계획" },
  "언제": { ic: "⏳", sub: "사업 단계" }, "리스크": { ic: "⚠️", sub: "리스크" },
  "진입": { ic: "🚪", sub: "진입 가능성" },
};

// 본문(### 라벨\n내용)을 섹션 카드로 분해. 태그 없는 깨끗한 문장만 들어온다(백엔드가 제거).
function parseSections(text) {
  if (!text) return [];
  return text.split(/^###\s+/m).map((b) => b.trim()).filter(Boolean).map((blk) => {
    const nl = blk.indexOf("\n");
    return { label: (nl < 0 ? blk : blk.slice(0, nl)).trim(), body: (nl < 0 ? "" : blk.slice(nl + 1)).trim() };
  });
}

const stripYear = (s) => (s || "").replace(/\s*\(\d{4}\)\s*$/, "").trim();   // 이름 끝 " (2009)" 제거(t와 중복)
const statusText = (m) => (m.t ? `${m.t}년 지정` : "");   // ★진행상태(completed) 미표시 — 신뢰도 불확실. 지정연도(t)만.

// ★히어로 — "닮은 재개발 동네"(우리 강점, 최상위). r.retrieval.matches.
// 유사도 표기 — similarity_pct("상위 N%") 우선, 없으면 raw %로 graceful fallback(구버전 캐시/폴백).
const simText = (m) => {
  const p = m?.similarity_pct;
  if (p == null) return `${Math.round(m.similarity * 100)}%`;       // 폴백(구버전): raw %
  return p < 1 ? "상위 1% 이내" : `상위 ${p}%`;
};

function SimilarHero({ matches }) {
  const [top, ...rest] = matches;
  const hasPct = top?.similarity_pct != null;
  return (
    <section className="sim">
      <h2 className="sim-title">이 동네는 재개발로 진행된 동네와 닮았습니다</h2>
      <div className="sim-top">
        <div className="sim-num">
          <div className="sim-pct">{simText(top)}</div>
          <div className="sim-envlabel">환경 유사</div>
        </div>
        <div className="sim-top-i">
          <div className="sim-name">{stripYear(top.display_name)}</div>
          {statusText(top) && <span className="sim-status">{statusText(top)}</span>}
        </div>
      </div>
      {rest.length > 0 && (
        <div className="sim-rest">
          {rest.map((m, i) => (
            <div key={i} className="sim-card">
              <div className="sim-name-s">{stripYear(m.display_name)}</div>
              <div className="sim-meta-s">{simText(m)}{statusText(m) ? ` · ${statusText(m)}` : ""}</div>
            </div>
          ))}
        </div>
      )}
      <p className="sim-disc">재개발이 진행된 실제 동네와 얼마나 닮았는지를 보여줍니다.
        {hasPct && " ‘상위 N%’는 서울 후보 구역 간 비교에서의 상대 순위입니다."} 닮음이 곧 재개발 확정은 아닙니다.</p>
    </section>
  );
}

// 왜 닮았나 — top_similar_axes에 든 축만 + query_metrics 입력값(매치 수치는 API에 없음 → 비교 안 함).
const _AXIS = { "노후도": ["old_area_ratio", "%", 100], "면적": ["area_ha", "ha", 1], "호수밀도": ["house_density", "", 1], "접도율": ["abut_ratio", "%", 100] };
function WhySimilar({ retrieval }) {
  const top = retrieval?.matches?.[0];
  const ctr = top?.contrast;
  // ★신규: 1위 구역 대비설명(닮은 축 / 다른 축). 없으면(구버전) 기존 top_similar_axes+query_metrics로 폴백.
  if (ctr && ctr.similar?.length) {
    return (
      <section className="why">
        <h3>왜 닮았나</h3>
        <p>닮은 점: {ctr.similar.join("·")}{ctr.different ? ` / 다른 점: ${ctr.different}` : ""}</p>
      </section>
    );
  }
  const axes = top?.top_similar_axes || [];
  const qm = retrieval?.query_metrics || {};
  const parts = axes.map((ax) => {
    const m = _AXIS[ax]; if (!m) return null;
    const v = qm[m[0]]; if (v == null) return ax;
    const val = m[2] === 100 ? Math.round(v * 100) : Math.round(v);
    return `${ax}(${val}${m[1]})`;                       // "노후도(100%)"
  }).filter(Boolean);
  if (!parts.length) return null;
  return (
    <section className="why">
      <h3>왜 닮았나</h3>
      <p>가장 닮은 점은 {parts.join(", ")}입니다.</p>
    </section>
  );
}

// 폴백 — 닮은 동네 없을 때(정직). kind: none(비후보) | partial(7구 밖).
function Fallback({ kind, fe, note }) {
  return (
    <section className="fb">
      {kind === "partial"
        ? <><h2 className="fb-title">이 주소는 아직 정밀 분석 범위 밖입니다</h2>
            <p className="fb-sub">현재 서울 7개 구만 지원합니다. {note ? "" : "지정 여부·상세는 제공되지 않습니다."}</p></>
        : <><h2 className="fb-title">최근 재개발로 진행된 동네와 뚜렷이 닮은 곳이 없습니다</h2>
            <p className="fb-sub">이 동네는 재개발이 진행된 실제 사례와의 유사도가 낮습니다.</p></>}
      {fe && <div className="score-line"><span className="sl-env">재개발 환경 유사도 {simGrade(fe.rank_top_pct) || "—"} · {fe.rank_phrase}</span></div>}
    </section>
  );
}

// 리스크 본문에서 유사사례 문장 제거(히어로로 이동) — 프론트 후처리.
const stripSimilar = (b) => b
  .replace(/[^.·\n]*유사[^.·\n]*%[^.·\n]*[.·]?/g, "")
  .replace(/유사사례[^.·\n]*[.·]?/g, "")
  .replace(/\s{2,}/g, " ").replace(/^[·.\s]+/, "").trim();

// 즐겨찾기 하트 — 리포트의 pnu를 watchlist에 토글 저장(supabase 직접, RLS=본인만).
// 진입 시 select로 이미 저장됐는지 확인 → 채움/빈하트. 추가는 upsert(UNIQUE라 중복 안 쌓임), 재클릭은 delete.
function FavoriteButton({ pnu, address, session }) {
  const uid = session?.user?.id;
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {                                   // ★진입 시 저장 여부 조회
    let alive = true;
    setErr(null);
    if (!supabase || !uid || !pnu) { setSaved(false); return; }
    supabase.from("watchlist").select("id").eq("user_id", uid).eq("pnu", pnu).maybeSingle()
      .then(({ data, error }) => { if (alive) { if (error) setErr(error.message); setSaved(Boolean(data)); } });
    return () => { alive = false; };
  }, [uid, pnu]);
  if (!supabase || !uid || !pnu) return null;         // 로그인 안 됐거나 필지 없으면 버튼 숨김
  const toggle = async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      if (saved) {                                    // 토글 해제 — 본인·해당 필지 행 삭제
        const { error } = await supabase.from("watchlist").delete().eq("user_id", uid).eq("pnu", pnu);
        if (error) throw error;
        setSaved(false);
      } else {                                         // 추가 — UNIQUE(user_id,pnu) 충돌은 무시(멱등)
        const { error } = await supabase.from("watchlist")
          .upsert({ user_id: uid, pnu, address }, { onConflict: "user_id,pnu" });
        if (error) throw error;
        setSaved(true);
      }
    } catch (e) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="fav-row">
      <button className={`fav-btn${saved ? " on" : ""}`} onClick={toggle} disabled={busy}
        aria-pressed={saved} title={saved ? "즐겨찾기 해제" : "즐겨찾기 추가"}>
        <Heart size={16} fill={saved ? "currentColor" : "none"} />
        <span>{saved ? "저장됨" : "즐겨찾기"}</span>
      </button>
      {err && <span className="fav-err">저장 실패: {err}</span>}
    </div>
  );
}

function ReportPanel({ r, session, address }) {
  if (!r) return <p className="muted">주소를 입력하면 닮은 재개발 동네 분석이 나옵니다.</p>;
  if (r.error) return <p style={{ color: "#c00" }}>{r.error}</p>;
  const partial = r.scope === "global_partial";
  const matches = r.retrieval?.matches || [];
  const fe = r.stages?.["예언_환경점수"]?.result;
  const facts = r.report?.source_facts || {};
  const sections = parseSections(r.report?.report_text)
    .map((s) => (s.label === "리스크" ? { ...s, body: stripSimilar(s.body) } : s))
    .filter((s) => s.body);                              // 유사사례만 있던 리스크는 비면 제거
  return (
    <div className="report">
      {/* 즐겨찾기 — 로그인 + 필지(pnu) 있을 때만 (FavoriteButton 내부 가드) */}
      <FavoriteButton pnu={r.pnu} address={address} session={session} />
      {/* 히어로: 닮은 동네 / 폴백 */}
      {partial ? <Fallback kind="partial" note={r.report?.partial_note} />
        : matches.length ? <><SimilarHero matches={matches} /><WhySimilar retrieval={r.retrieval} /></>
        : <Fallback kind="none" fe={fe} />}
      {partial && r.report?.partial_note && <div className="partial-note">ℹ️ {r.report.partial_note}</div>}

      {/* 부가 — 5종 상세, 접기 가능 */}
      {sections.length > 0 && (
        <details className="extra" open>
          <summary>상세 분석 (될까 · 얼마 · 언제 · 리스크 · 진입)</summary>
          <div className="cards">
            {sections.map((s, i) => {
              const m = SECTION_META[s.label] || { ic: "•", sub: "" };
              return (
                <div key={i} className="card">
                  <div className="card-h"><span className="ic">{m.ic}</span><b>{s.label}</b><span className="card-sub">{m.sub}</span></div>
                  <div className="card-b">{s.body}</div>
                  {/* 환경점수는 96%(닮음)와 안 싸우게 '전체 기준' 명시, '될까'에 작게 */}
                  {s.label === "될까" && fe && <div className="card-env">서울 전체 기준 재개발 유사 환경: {fe.rank_phrase}</div>}
                </div>
              );
            })}
          </div>
        </details>
      )}
      {Object.keys(facts).length > 0 && <details className="src">
        <summary>출처·근거 ({Object.keys(facts).length})</summary>
        <table className="src-t"><tbody>{Object.entries(facts).map(([k, v]) => (
          <tr key={k}><td>{k}</td><td>{v}</td></tr>))}</tbody></table>
      </details>}
      <details>
        <summary>한계·주의 ({r.report?.caveats_user?.length || 0})</summary>
        <ul>{(r.report?.caveats_user || []).map((c, i) => <li key={i}>{c}</li>)}</ul>
      </details>
      <div className="muted">추정·참고치 · 투자 권유 아님</div>
    </div>
  );
}

function Screener({ onPick }) {
  const [gu, setGu] = useState("11590");
  const [kind, setKind] = useState("cluster");     // ★필터: 지정/후보/전체 — 점수 포화라 %밴드는 제거(no-op)
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ran, setRan] = useState(false);
  const run = () => {
    setLoading(true);
    authedFetch(`/screen?gu=${gu}&kind=${kind}&top_k=30`).then((r) => r.json())
      .then((d) => { setItems(d.results || []); setLoading(false); setRan(true); });
  };
  return (
    <div>
      <div className="filters">
        <select value={gu} onChange={(e) => setGu(e.target.value)}>
          <option value="11290">성북구</option><option value="11590">동작구</option>
          <option value="11380">은평구</option><option value="11530">구로구</option>
          <option value="11440">마포구</option><option value="11680">강남구</option>
        </select>
        {/* ★필터 = 카테고리(점수 포화라 %밴드는 표시리스트를 못 바꿔 제거). 정렬은 환경 유사 높은 순 */}
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="cluster">후보 군집</option>
          <option value="zone">지정 정비구역</option>
          <option value="all">전체(환경 유사 높은 순)</option>
        </select>
        <button onClick={run}>검색</button>
      </div>
      {loading ? <p className="muted">검색 중…</p>
        : !ran ? <p className="muted">구 + 환경 상위 밴드를 고르고 검색하세요.</p>
        : items.length === 0 ? <p className="muted">해당 조건의 후보가 없습니다.</p>
        : items.map((it) => {
          const badge = it.in_zone ? (it.zone_name || "지정 정비구역") : it.cluster ? "후보 군집" : "관심";
          const tone = it.in_zone ? "b-desig" : it.cluster ? "b-cand" : "b-none";
          return (
            <div key={it.pnu} className="screen-item" onClick={() => onPick([it.lat, it.lon])}>
              <div className="si-top">
                <span className="si-addr">{it.address || ("필지 …" + it.pnu.slice(-8))}</span>
                <span className={`si-badge ${tone}`}>{badge}</span>
              </div>
              <div className="si-meta">재개발 환경 유사 {simGrade(it.rank_pct) || "—"} · 전 구역 상위 {it.rank_pct}%</div>
            </div>
          );
        })}
    </div>
  );
}

// ★지도 범례 — 색 스케일 + 의미 + R18 오독 차단(유사도일 뿐 재개발 확정 아님) + 군집 설명.
function MapLegend() {
  return (
    <div className="legend">
      <div className="lg-title">색 = 재개발 환경 유사도</div>
      <div className="lg-bar"><span>높음</span><div className="lg-grad" /><span>낮음</span></div>
      <div className="lg-note"><b style={{ color: "#b91c1c" }}>빨강</b> = 노후 환경이 재개발된 동네와 닮음 · <b style={{ color: "#15803d" }}>초록</b> = 거리 멂</div>
      <div className="lg-warn">※ 점 색은 필지별 노후 환경 유사도일 뿐, 재개발 확정·가능성·구역 경계가 아닙니다</div>
    </div>
  );
}

// ───────── 기능 페이지(검색·스크리너·지도) — 기존 기능 그대로, 사이트 안으로 편입 ─────────
function Workspace({ session, pendingAddr, onConsumePending }) {
  const [tab, setTab] = useState("search");
  const [addr, setAddr] = useState("성북구 정릉동 170-1");
  const [report, setReport] = useState(null);
  const [pos, setPos] = useState(null);
  const search = (a = addr) => {
    setReport({ loading: true });
    /* ★stage 하드코딩 금지(누수 경로) — 실제 단계를 모르면 보내지 않는다. in_zone+stage일 때만 '언제' 출력 */
    authedFetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: a, property_type: "다세대" }) })
      .then(async (r) => {
        if (r.status === 429) {                        // ★한도 초과 — alert 남발 말고 인라인 안내
          const d = await r.json().catch(() => ({}));
          setReport({ rateLimited: d.detail || "요청이 많습니다. 잠시 후 다시 시도해주세요." });
          return;
        }
        const j = await r.json();
        setReport(j);
        if (j.lat) setPos([j.lat, j.lon]);
      })
      .catch((e) => setReport({ error: String(e) }));
  };
  // ★마이페이지 항목 클릭 → pendingAddr로 들어옴: 검색탭 + 주소 세팅 + 분석을 같은 경로로 재사용.
  useEffect(() => {
    if (!pendingAddr) return;
    setTab("search");
    setAddr(pendingAddr);
    search(pendingAddr);
    onConsumePending?.();                              // 1회 소비 — 재진입 시 재분석 방지
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAddr]);
  return (
    <div className="app">
      <div className="panel">
        <div className="tabs">
          <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>주소 검색</button>
          <button className={tab === "screener" ? "active" : ""} onClick={() => setTab("screener")}>스크리너</button>
        </div>
        {tab === "search" ? (
          <>
            <div className="search">
              <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="지번 주소 (예: 성북구 정릉동 170-1)" />
              <button onClick={() => search()}>분석</button>
            </div>
            {report?.loading ? <p className="muted">분석 중…</p>
              : report?.rateLimited ? <p className="rate-limit-msg" role="alert">{report.rateLimited}</p>
              : <ReportPanel r={report} session={session} address={addr} />}
          </>
        ) : (
          <Screener onPick={setPos} />
        )}
      </div>
      <div className="map">
        <MapContainer center={SEOUL} zoom={12} style={{ height: "100%" }}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
          <BboxLayer />
          {pos && <Marker position={pos} />}
          <FlyTo pos={pos} />
        </MapContainer>
        <MapLegend />
      </div>
    </div>
  );
}

// 마이페이지 사이드 메뉴 — 즐겨찾기 / 내 글(향후 '설정' 등 추가 자리).
const MP_MENUS = [{ id: "watchlist", label: "즐겨찾기" }, { id: "myposts", label: "내 글" }];

// 즐겨찾기 패널 — 목록·클릭이동·삭제(이전 단계 로직 재사용).
function WatchlistPanel({ uid, openReport }) {
  const [items, setItems] = useState(null);            // null=로딩, []=빈, [...]=목록
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!supabase || !uid) { setItems([]); return; }
    supabase.from("watchlist").select("pnu,address,created_at")
      .eq("user_id", uid).order("created_at", { ascending: false })
      .then(({ data, error }) => { if (!alive) return; if (error) setErr(error.message); setItems(data || []); });
    return () => { alive = false; };
  }, [uid]);
  const remove = async (pnu) => {
    const prev = items;
    setItems(items.filter((it) => it.pnu !== pnu));     // 낙관적 제거
    const { error } = await supabase.from("watchlist").delete().eq("user_id", uid).eq("pnu", pnu);
    if (error) { setErr(error.message); setItems(prev); } // 실패 시 롤백
  };
  return (
    <section>
      <h2 className="mp-h2">즐겨찾기 {Array.isArray(items) && items.length > 0 && <span className="mp-cnt">{items.length}</span>}</h2>
      {err && <p className="fav-err">불러오기 실패: {err}</p>}
      {items === null ? <p className="muted">불러오는 중…</p>
        : items.length === 0 ? <p className="muted">아직 즐겨찾기한 곳이 없습니다. 주소를 분석한 뒤 하트를 눌러 저장해 보세요.</p>
        : (
          <ul className="mp-list">
            {items.map((it) => (
              <li key={it.pnu} className="mp-item">
                <button className="mp-go" onClick={() => openReport(it.address)} title="이 주소 분석으로 이동">
                  <span className="mp-addr">{it.address || `필지 …${String(it.pnu).slice(-8)}`}</span>
                  <span className="mp-date">{(it.created_at || "").slice(0, 10)}</span>
                </button>
                <button className="mp-del" onClick={() => remove(it.pnu)} title="삭제" aria-label="삭제">✕</button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

// 내 글 패널 — 내가 쓴 posts 목록(즐겨찾기 UI 패턴 재사용). 클릭 → 상세(BoardDetail).
function MyPostsPanel({ uid, go }) {
  const [items, setItems] = useState(null);            // null=로딩
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!supabase || !uid) { setItems([]); return; }
    supabase.from("posts").select("id,title,created_at,updated_at")
      .eq("user_id", uid).order("created_at", { ascending: false })
      .then(({ data, error }) => { if (!alive) return; if (error) setErr(error.message); setItems(data || []); });
    return () => { alive = false; };
  }, [uid]);
  return (
    <section>
      <h2 className="mp-h2">내 글 {Array.isArray(items) && items.length > 0 && <span className="mp-cnt">{items.length}</span>}</h2>
      {err && <p className="fav-err">불러오기 실패: {err}</p>}
      {items === null ? <p className="muted">불러오는 중…</p>
        : items.length === 0 ? <p className="muted">작성한 글이 없습니다.</p>
        : (
          <ul className="mp-list">
            {items.map((p) => (
              <li key={p.id} className="mp-item">
                <button className="mp-go" onClick={() => go(`board/${p.id}`)} title="글 보기">
                  <span className="mp-addr">{p.title}{isEdited(p) && <span className="bi-edited">수정됨</span>}</span>
                  <span className="mp-date">{(p.created_at || "").slice(0, 10)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

// 닉네임 형식 — 2~20자, 한글·영문·숫자·일부 기호(_ - .). 공백/특수문자 차단.
const NICK_RE = /^[가-힣a-zA-Z0-9_.\-]{2,20}$/;

// ★닉네임 저장(공용) — profiles 본인 행 update. 성공이면 null, 실패면 사용자용 메시지.
//   중복은 DB UNIQUE(lower(nickname))가 막고 위반코드 23505를 잡는다(동시성 source of truth).
async function updateNickname(uid, v) {
  const { error } = await supabase.from("profiles").update({ nickname: v }).eq("id", uid);
  if (!error) return null;
  return error.code === "23505" ? "이미 사용 중인 닉네임입니다." : (error.message || "저장 실패");
}
// 사전 중복 체크(UX용) — true=사용중, false=가능, null=판단보류(조회 실패).
//   ★RLS(profiles_self_select=본인 행만)로 직접 select는 남의 닉을 못 봄 → security definer RPC(nickname_taken)로 조회.
//   대소문자 무시(RPC가 lower 비교). 최종 방어는 저장 시 UNIQUE 23505.
async function nicknameTaken(v) {
  const { data, error } = await supabase.rpc("nickname_taken", { p: v });
  if (error) return null;
  return Boolean(data);
}

// 닉네임 표시 + 인라인 편집 — profiles.nickname을 본인 행에 update(RLS profiles_self_update).
// 중복은 DB UNIQUE(lower(nickname))가 막고, 위반코드 23505를 catch(동시성 source of truth).
function NicknameEditor({ uid, nickname, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(nickname || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const start = () => { setDraft(nickname || ""); setErr(null); setEditing(true); };
  const cancel = () => { setEditing(false); setErr(null); };
  const save = async () => {
    const v = draft.trim();
    if (!NICK_RE.test(v)) { setErr("2~20자, 한글·영문·숫자·_-. 만 사용할 수 있습니다."); return; }
    if (v === (nickname || "")) { setEditing(false); return; }   // 변경 없음
    setBusy(true); setErr(null);
    const msg = await updateNickname(uid, v);                     // 공용 저장(23505 처리 포함)
    setBusy(false);
    if (msg) { setErr(msg); return; }
    onSaved(v);                                                   // 카드 즉시 반영
    setEditing(false);
  };
  if (!editing) return (
    <div className="mp-nick">
      <span className={`mp-nick-v${nickname ? "" : " ph"}`}>{nickname || "닉네임 미설정"}</span>
      <button className="mp-nick-edit" onClick={start}>수정</button>
    </div>
  );
  return (
    <div className="mp-nick editing">
      <div className="mp-nick-row">
        <input className="mp-nick-input" value={draft} maxLength={20} autoFocus
          placeholder="닉네임 (2~20자)" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }} />
        <button className="mp-nick-save" disabled={busy} onClick={save}>{busy ? "저장 중…" : "저장"}</button>
        <button className="mp-nick-cancel" disabled={busy} onClick={cancel}>취소</button>
      </div>
      {err && <span className="fav-err">{err}</span>}
    </div>
  );
}

// ───────── 첫 로그인 닉네임 설정 게이트 — 닉네임 없으면 메인 진입 전 1회(스킵 불가, 로그아웃은 가능) ─────────
function NicknameSetup({ uid, onDone, logout }) {
  const [draft, setDraft] = useState("");
  const [avail, setAvail] = useState(null);            // null=미확인/형식미달, true=가능, false=사용중
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const v = draft.trim();
  const validFmt = NICK_RE.test(v);
  useEffect(() => {                                     // ★입력 중 사전 중복 체크(디바운스, UX)
    setErr(null);
    if (!validFmt) { setAvail(null); return; }
    let alive = true;
    const t = setTimeout(async () => {
      const taken = await nicknameTaken(v);
      if (alive) setAvail(taken == null ? null : !taken);
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [v, validFmt, uid]);
  const save = async () => {
    if (!validFmt) { setErr("2~20자, 한글·영문·숫자·_-. 만 사용할 수 있습니다."); return; }
    if (avail === false) { setErr("이미 사용 중인 닉네임입니다."); return; }
    setBusy(true); setErr(null);
    const msg = await updateNickname(uid, v);           // 최종 방어 = 23505
    setBusy(false);
    if (msg) { setErr(msg); if (msg.includes("사용 중")) setAvail(false); return; }
    onDone(v);                                          // 메인 진입
  };
  return (
    <main className="doc auth">
      <div className="auth-card">
        <h1>닉네임 설정</h1>
        <p className="auth-sub">서비스 이용을 위해 <b>닉네임</b>을 설정해 주세요. (2~20자, 한글·영문·숫자·_-.)</p>
        <input value={draft} maxLength={20} autoFocus placeholder="닉네임"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        {v && (validFmt
          ? (avail === false ? <div className="nick-hint bad">이미 사용 중인 닉네임입니다.</div>
            : avail === true ? <div className="nick-hint ok">사용 가능한 닉네임입니다.</div>
            : <div className="nick-hint">확인 중…</div>)
          : <div className="nick-hint bad">2~20자, 한글·영문·숫자·_-. 만 사용할 수 있습니다.</div>)}
        <button className="btn-primary" disabled={busy || !validFmt || avail === false} onClick={save}>
          {busy ? "저장 중…" : "닉네임 저장하고 시작하기"}
        </button>
        {err && <div className="auth-msg">{err}</div>}
        <div className="auth-switch"><button onClick={logout}>로그아웃</button></div>
      </div>
    </main>
  );
}

// ───────── 마이페이지 — 내 정보 + 사이드 메뉴 레이아웃 ─────────
function MyPage({ session, openReport, go }) {
  const uid = session?.user?.id;
  const email = session?.user?.email;
  const [menu, setMenu] = useState("watchlist");
  const [profile, setProfile] = useState(null);        // profiles 테이블(구독상태·가입일)
  useEffect(() => {
    let alive = true;
    if (!supabase || !uid) return;
    supabase.from("profiles").select("nickname,subscription_status,created_at").eq("id", uid).maybeSingle()
      .then(({ data }) => { if (alive && data) setProfile(data); });
    return () => { alive = false; };
  }, [uid]);
  if (!uid) {                                           // 미로그인 가드 — 로그인 유도
    return (
      <div className="mypage">
        <h1 className="mp-title">마이페이지</h1>
        <p className="muted">로그인 후 즐겨찾기한 곳을 볼 수 있습니다.</p>
        <button className="btn-primary" onClick={() => go("app")}>로그인하러 가기</button>
      </div>
    );
  }
  const joined = (profile?.created_at || session?.user?.created_at || "").slice(0, 10);
  const plan = profile?.subscription_status;
  return (
    <div className="mp">
      <h1 className="mp-title">마이페이지</h1>
      {/* 내 정보 — 닉네임(편집) + 이메일 + profiles(구독·가입일) */}
      <header className="mp-head">
        <div className="mp-avatar">{(profile?.nickname || email || "?").slice(0, 1).toUpperCase()}</div>
        <div className="mp-id">
          <NicknameEditor uid={uid} nickname={profile?.nickname}
            onSaved={(v) => setProfile((p) => ({ ...(p || {}), nickname: v }))} />
          <div className="mp-email">{email || "로그인 사용자"}</div>
          <div className="mp-meta">
            {plan && <span className="mp-plan">{plan === "free" ? "무료 플랜" : plan}</span>}
            {joined && <span>가입일 {joined}</span>}
          </div>
        </div>
      </header>
      {/* 사이드 메뉴 + 콘텐츠 */}
      <div className="mp-body">
        <aside className="mp-side">
          {MP_MENUS.map((m) => (
            <button key={m.id} className={`mp-menu${menu === m.id ? " on" : ""}`} onClick={() => setMenu(m.id)}>{m.label}</button>
          ))}
        </aside>
        <main className="mp-main">
          {menu === "watchlist" && <WatchlistPanel uid={uid} openReport={openReport} />}
          {menu === "myposts" && <MyPostsPanel uid={uid} go={go} />}
        </main>
      </div>
    </div>
  );
}

const BRAND = "재개발 투자 판단";
const NAV = [{ id: "home", label: "소개" }, { id: "guide", label: "이용방법" }, { id: "app", label: "검색" }, { id: "board", label: "게시판" }];
const FEATURES = [
  { Icon: MapPin, t: "주소로 환경 분석", d: "지번 하나로 그 일대의 노후 환경 유사도와 재개발 요건 충족 여부를 정리해 봅니다." },
  { Icon: MapIcon, t: "지도 시각화", d: "일대 필지의 환경 점수를 색으로 표시합니다. 구역 경계가 아닌 참고용 분포입니다." },
  { Icon: FileText, t: "계획정보 근거", d: "지정 정비구역이면 용적률·세대수 등을 고시문 출처와 함께 인용합니다." },
  { Icon: KeyRound, t: "진입 가능성", d: "토지거래허가 등 규제를 참고로 제시합니다. 수시 변경되니 사용 시점 고시 확인이 필요합니다." },
];

function Header({ view, go, session, logout }) {
  const [page] = view.split("/");                     // board/123 → board 하이라이트
  return (
    <header className="site-h">
      <div className="brand" onClick={() => go("home")} role="button">
        <span className="logo">▦</span>
        <span className="brand-name">{BRAND}</span>
        <span className="brand-tag">데이터 기반 재개발 환경 분석</span>
      </div>
      <div className="h-right">
        <nav className="site-nav">
          {NAV.map((n) => <button key={n.id} className={page === n.id ? "on" : ""} onClick={() => go(n.id)}>{n.label}</button>)}
          {session && <button className={page === "mypage" ? "on" : ""} onClick={() => go("mypage")}>마이페이지</button>}
        </nav>
        {session
          ? <button className="auth-btn" onClick={logout} title={session.user?.email}>로그아웃</button>
          : <button className="auth-btn solid" onClick={() => go("app")}>로그인</button>}
      </div>
    </header>
  );
}

// ★가입 필수 게이트 — 로그인/회원가입/비번재설정. 회원가입엔 개인정보 동의 필수.
function AuthPage({ onAuthed, go }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [agree, setAgree] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [nickname, setNickname] = useState("");
  const [nickAvail, setNickAvail] = useState(null);   // null=미확인/형식미달, true=가능, false=사용중
  const nv = nickname.trim();
  const nickValid = NICK_RE.test(nv);
  useEffect(() => {                                    // ★가입 모드 닉네임 사전 중복체크(디바운스, RPC)
    setNickAvail(null);
    if (mode !== "signup" || !nickValid || !supabase) return;
    let alive = true;
    const t = setTimeout(async () => {
      const taken = await nicknameTaken(nv);
      if (alive) setNickAvail(taken == null ? null : !taken);
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [nv, nickValid, mode]);
  if (!authReady) return (
    <main className="doc"><div className="legal-banner">인증이 아직 설정되지 않았습니다 — <b>.env</b>의
      <code> VITE_SUPABASE_URL</code>·<code>VITE_SUPABASE_ANON_KEY</code>를 넣고 재기동하세요(Supabase 셋업 후).</div></main>
  );
  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      if (mode === "signup") {
        if (!agree) { setMsg("개인정보(이메일) 수집·이용에 동의해야 가입할 수 있습니다."); setBusy(false); return; }
        if (!nickValid) { setMsg("닉네임은 2~20자, 한글·영문·숫자·_-. 만 사용할 수 있습니다."); setBusy(false); return; }
        if (nickAvail === false) { setMsg("이미 사용 중인 닉네임입니다."); setBusy(false); return; }
        const { error } = await supabase.auth.signUp({ email, password: pw, options: { data: { nickname: nv } } });
        if (error) {                                   // ★트리거가 닉네임 중복(UNIQUE)으로 실패하면 가입 에러
          const dup = error.code === "23505" || /duplicate|already|database error/i.test(error.message || "");
          throw new Error(dup ? "이미 사용 중인 닉네임입니다 — 다른 닉네임으로 다시 시도하세요." : (error.message || "가입 실패"));
        }
        setMsg("확인 메일을 보냈습니다 — 메일의 링크로 인증 후 로그인하세요.");
      } else if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
        onAuthed && onAuthed();
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email);
        if (error) throw error;
        setMsg("비밀번호 재설정 메일을 보냈습니다.");
      }
    } catch (e) { setMsg(e.message || String(e)); }
    setBusy(false);
  };
  const title = mode === "signup" ? "회원가입" : mode === "reset" ? "비밀번호 재설정" : "로그인";
  return (
    <main className="doc auth">
      <div className="auth-card">
        <h1>{title}</h1>
        <p className="auth-sub">검색·결과·스크리너는 <b>회원만</b> 이용할 수 있습니다.</p>
        <input type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode !== "reset" && <input type="password" placeholder="비밀번호 (6자 이상)" value={pw} onChange={(e) => setPw(e.target.value)} />}
        {mode === "signup" && (
          <>
            <input placeholder="닉네임 (2~20자)" value={nickname} maxLength={20} onChange={(e) => setNickname(e.target.value)} />
            {nv && (nickValid
              ? (nickAvail === false ? <div className="nick-hint bad">이미 사용 중인 닉네임입니다.</div>
                : nickAvail === true ? <div className="nick-hint ok">사용 가능한 닉네임입니다.</div>
                : <div className="nick-hint">확인 중…</div>)
              : <div className="nick-hint bad">2~20자, 한글·영문·숫자·_-. 만 사용할 수 있습니다.</div>)}
            <label className="auth-agree">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>[필수] 개인정보(이메일) 수집·이용 동의 — <a onClick={() => go("privacy")}>개인정보처리방침</a> · <a onClick={() => go("disclaimer")}>면책</a> (초안)</span>
            </label>
          </>
        )}
        <button className="btn-primary" disabled={busy || (mode === "signup" && (!nickValid || nickAvail === false))} onClick={submit}>{busy ? "처리 중…" : title}</button>
        {msg && <div className="auth-msg">{msg}</div>}
        <div className="auth-switch">
          {mode !== "login" && <button onClick={() => { setMode("login"); setMsg(null); }}>로그인</button>}
          {mode !== "signup" && <button onClick={() => { setMode("signup"); setMsg(null); }}>회원가입</button>}
          {mode !== "reset" && <button onClick={() => { setMode("reset"); setMsg(null); }}>비밀번호 찾기</button>}
        </div>
      </div>
    </main>
  );
}

// 메인 노출용 — 게시판 "이주의 Best" Top3(읽기 공개 RPC, 비로그인도 보임). 0개면 섹션 미표시.
function LandingBest({ go }) {
  const [best, setBest] = useState([]);
  useEffect(() => {
    let alive = true;
    if (!supabase) return;
    supabase.rpc("board_best", { days: 7, lim: 3 })
      .then(({ data }) => { if (alive && Array.isArray(data)) setBest(data); });   // 실패/0개면 섹션 생략
    return () => { alive = false; };
  }, []);
  if (best.length === 0) return null;
  const MEDALS = ["🥇", "🥈", "🥉"];
  return (
    <section className="lp-best-wrap">
      <div className="lp-inner">
        <div className="lp-best-head">
          <h2 className="lp-best-h">🔥 지금 사람들이 보는 글</h2>
          <button className="lp-best-more" onClick={() => go("board")}>게시판 가기 →</button>
        </div>
        <ul className="lp-best">
          {best.map((p, i) => (
            <li key={p.id} className="lp-best-item" onClick={() => go(`board/${p.id}`)} role="button">
              <span className="lp-best-medal">{MEDALS[i]}</span>
              <span className="lp-best-title">{p.title}</span>
              <span className="lp-best-author">{p.author_nick || "익명"}</span>
              {p.like_count > 0 && <span className="lp-best-like">♥ {p.like_count}</span>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Landing({ go }) {
  return (
    <main className="landing">
      <section className="lp-hero">
        <div className="lp-inner">
          <span className="lp-eyebrow">데이터 기반 · 참고용 분석</span>
          <h1>주소 하나로,<br />그 일대의 <b>재개발 환경</b>을 읽습니다.</h1>
          <p className="lp-sub">노후 환경·재개발 요건·계획정보·진입 규제를 데이터로 정리해 보여주는 참고 도구입니다.
            재개발 여부나 수익을 확정하지 않습니다.</p>
          <div className="lp-cta">
            <button className="btn-primary" onClick={() => go("app")}>주소 검색 시작 <ArrowRight size={17} strokeWidth={2.2} /></button>
            <button className="btn-ghost" onClick={() => go("guide")}>이용 방법 보기</button>
          </div>
        </div>
      </section>
      <LandingBest go={go} />
      <section className="lp-feat-wrap">
        <div className="lp-inner">
          <div className="lp-feat">
            {FEATURES.map((f) => (
              <div key={f.t} className="feat">
                <div className="feat-ic"><f.Icon size={22} strokeWidth={1.75} /></div>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="lp-honest-wrap">
        <div className="lp-inner">
          <div className="lp-honest">
            <div className="honest-ic"><ShieldCheck size={22} strokeWidth={1.75} /></div>
            <div>
              <h3>이 서비스가 하지 않는 것</h3>
              <p>재개발 확정·미래 가격·정확한 수익률을 단정하지 않습니다. 모든 수치는 추정·참고치이며, 투자 결정과
                책임은 이용자 본인에게 있습니다. 데이터 한계(학습 지역 외 상세 미제공, 라벨 커버리지 등)는 결과 화면에
                명시합니다.</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function Guide({ go }) {
  const steps = [
    ["주소 입력", "검색 화면에 지번 주소를 입력합니다 (예: 성북구 정릉동 170-1). 도로명은 현재 미지원입니다."],
    ["환경 점수·판정 확인", "상단 카드에서 지정 정비구역 / 환경 유사 후보 / 대상 아님 판정과 '재개발 환경 유사도'(높음·중간·낮음)를 봅니다. 유사도는 '닮은 정도'일 뿐 재개발 확정이 아닙니다."],
    ["상세 읽기", "될까·얼마·언제·리스크·진입 5개 항목을 카드로 봅니다. 모두 추정·참고치이며, 출처는 '출처·근거'에서 확인할 수 있습니다."],
    ["지도·스크리너", "지도는 일대 환경 점수를 색으로, 스크리너는 구별 후보/지정 구역 리스트를 보여줍니다."],
  ];
  return (
    <main className="doc">
      <h1>이용 방법</h1>
      <ol className="guide">
        {steps.map(([t, d], i) => <li key={i}><b>{t}</b><p>{d}</p></li>)}
      </ol>
      <div className="note-box">학습 지역(7개 구) 밖 주소는 환경 점수·판정만 제공하고 시세·노후도 등 상세는 제공하지 않습니다(결과 화면에 표시).</div>
      <button className="btn-primary" onClick={() => go("app")}>검색하러 가기</button>
    </main>
  );
}

const LEGAL = {
  terms: { title: "이용약관", secs: ["목적", "정의", "서비스의 내용", "이용자의 의무", "서비스 이용 제한", "면책 조항", "지식재산권", "약관의 변경", "준거법 및 관할"] },
  privacy: { title: "개인정보처리방침", secs: ["수집하는 개인정보 항목", "수집 및 이용 목적", "보유 및 이용 기간", "제3자 제공", "처리 위탁", "이용자의 권리와 행사 방법", "개인정보 보호책임자 및 문의처"] },
  disclaimer: { title: "면책 고지", secs: ["서비스의 성격", "데이터의 한계", "투자 책임의 귀속"] },
};

function Legal({ kind }) {
  const L = LEGAL[kind] || LEGAL.terms;
  return (
    <main className="doc legal">
      <h1>{L.title}</h1>
      <div className="legal-banner">⚠️ 본 문서는 <b>초안 골격</b>이며, 정식 서비스 전 <b>법무 검토·표준양식 적용 예정</b>입니다.
        현재는 섹션 구성만 표시하며 확정된 법적 효력이 없습니다.</div>
      {kind === "disclaimer" && (
        <p className="legal-core">본 서비스는 <b>투자 자문이 아니라 데이터 기반 참고 정보</b>를 제공합니다. 제공되는 점수·판정·
          계획정보·시세 맥락은 모두 추정·참고치이며 재개발 여부나 수익을 보장하지 않습니다. <b>투자 결정과 그 결과에
          대한 책임은 전적으로 이용자 본인에게 있습니다.</b></p>
      )}
      <ol className="legal-secs">
        {L.secs.map((s, i) => <li key={i}><b>{s}</b><span className="legal-ph">[검토 전 — 내용 미작성]</span></li>)}
      </ol>
    </main>
  );
}

function Footer({ go }) {
  return (
    <footer className="site-f">
      <div className="f-row">
        <div className="f-brand">{BRAND}<span> · 데이터 기반 재개발 환경 분석(참고용)</span></div>
        <nav className="f-nav">
          <button onClick={() => go("home")}>소개</button>
          <button onClick={() => go("guide")}>이용방법</button>
          <button onClick={() => go("terms")}>이용약관</button>
          <button onClick={() => go("privacy")}>개인정보처리방침</button>
          <button onClick={() => go("disclaimer")}>면책</button>
        </nav>
      </div>
      <div className="f-disc">본 서비스는 투자 권유가 아니며, 모든 수치는 추정·참고치입니다. 투자 결정은 이용자 본인 책임입니다.
        · 데이터 출처: 국토교통부·서울특별시 공공데이터(출처표시).</div>
    </footer>
  );
}

// 수정됨 판정 — updated_at가 created_at보다 1초+ 뒤면 수정된 글(insert 시엔 동일).
const isEdited = (p) => p.created_at && p.updated_at && (new Date(p.updated_at) - new Date(p.created_at) > 1000);

// ───────── 게시판 목록 — 읽기 공개(비로그인도 열람). 작성/상세는 다음 단계 ─────────
function BoardList({ session, go }) {
  const [posts, setPosts] = useState(null);            // null=로딩
  const [best, setBest] = useState([]);                // 최근 7일 좋아요순 Top3(board_best RPC)
  const [err, setErr] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!supabase) { setPosts([]); return; }
    supabase.from("posts").select("id,title,author_nick,created_at,updated_at,comments(count),post_likes(count)").order("created_at", { ascending: false })
      .then(({ data, error }) => { if (!alive) return; if (error) setErr(error.message); setPosts(data || []); });
    supabase.rpc("board_best", { days: 7, lim: 3 })    // 실패해도 목록은 정상(Best만 생략)
      .then(({ data }) => { if (alive && Array.isArray(data)) setBest(data); });
    return () => { alive = false; };
  }, []);
  const MEDALS = ["🥇", "🥈", "🥉"];
  const bestIds = new Set(best.map((b) => b.id));
  const rest = (posts || []).filter((p) => !bestIds.has(p.id));   // ★Best는 위 고정만 — 아래 목록서 제외
  // medal: Best 행이면 메달+7일 좋아요수, 일반 행이면 전체 좋아요/댓글 수
  const renderRow = (p, medal) => (
    <li key={p.id} className="board-item" onClick={() => go(`board/${p.id}`)} role="button">
      <div className="bi-title">{medal && <span className="bi-medal">{medal}</span>}{p.title}{isEdited(p) && <span className="bi-edited">수정됨</span>}</div>
      <div className="bi-meta">
        <span className="bi-author">{p.author_nick || "익명"}</span>
        <span className="bi-date">{(p.created_at || "").slice(0, 10)}</span>
        {medal
          ? (p.like_count > 0 && <span className="bi-like">♥ {p.like_count}</span>)
          : (<>
              {p.post_likes?.[0]?.count > 0 && <span className="bi-like">♥ {p.post_likes[0].count}</span>}
              {p.comments?.[0]?.count > 0 && <span className="bi-cmt">💬 {p.comments[0].count}</span>}
            </>)}
      </div>
    </li>
  );
  return (
    <main className="board">
      <div className="board-head">
        <h1 className="board-title">게시판</h1>
        {session && <button className="btn-primary board-write" onClick={() => go("board/new")}>글쓰기</button>}
      </div>
      {err && <p className="fav-err">불러오기 실패: {err}</p>}
      {posts === null ? <p className="muted">불러오는 중…</p>
        : posts.length === 0 ? <p className="muted">아직 글이 없습니다.</p>
        : (
          <>
            {best.length > 0 && (
              <section className="board-best">
                <h2 className="board-best-h">🔥 이주의 Best</h2>
                <ul className="board-list">{best.map((p, i) => renderRow(p, MEDALS[i]))}</ul>
              </section>
            )}
            <ul className="board-list">{rest.map((p) => renderRow(p, null))}</ul>
          </>
        )}
    </main>
  );
}

// ───────── 게시판 글쓰기 — 로그인+닉네임 필수. user_id·author_nick은 트리거가 채움 ─────────
function BoardWrite({ session, nick, go }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!session) {                                      // 비로그인 — 작성 로그인 필수
    return (
      <main className="doc auth"><div className="auth-card">
        <h1>글쓰기</h1>
        <p className="auth-sub">글 작성은 <b>로그인</b> 후 가능합니다.</p>
        <button className="btn-primary" onClick={() => go("app")}>로그인하러 가기</button>
        <div className="auth-switch"><button onClick={() => go("board")}>← 게시판으로</button></div>
      </div></main>
    );
  }
  if (nick === undefined) return <main className="doc auth"><div className="auth-card"><p className="muted">불러오는 중…</p></div></main>;
  if (!nick) {                                         // 닉네임 미설정 — author_nick 보장 위해 먼저 설정
    return (
      <main className="doc auth"><div className="auth-card">
        <h1>글쓰기</h1>
        <p className="auth-sub">글 작성 전 <b>닉네임</b>을 먼저 설정해 주세요.</p>
        <button className="btn-primary" onClick={() => go("app")}>닉네임 설정하러 가기</button>
        <div className="auth-switch"><button onClick={() => go("board")}>← 게시판으로</button></div>
      </div></main>
    );
  }
  const t = title.trim(), b = body.trim();
  const valid = t.length >= 2 && t.length <= 100 && b.length >= 1 && b.length <= 5000;
  const submit = async () => {
    if (!valid) { setErr("제목 2~100자, 내용 1~5000자로 입력해 주세요."); return; }
    setBusy(true); setErr(null);
    // ★title·body만 전송 — user_id·author_nick·시각은 posts_stamp 트리거가 채움. id는 받아서 상세로 이동.
    const { data, error } = await supabase.from("posts").insert({ title: t, body: b }).select("id").single();
    setBusy(false);
    if (error) { setErr(error.message || "작성 실패"); return; }
    go(data?.id ? `board/${data.id}` : "board");       // 상세(다음 단계) — 없으면 목록
  };
  return (
    <main className="board">
      <div className="board-head"><h1 className="board-title">글쓰기</h1></div>
      <div className="bw-form">
        <input className="bw-title" placeholder="제목 (2~100자)" value={title} maxLength={100}
          onChange={(e) => setTitle(e.target.value)} />
        <textarea className="bw-body" placeholder="내용" value={body} maxLength={5000} rows={12}
          onChange={(e) => setBody(e.target.value)} />
        {err && <p className="fav-err">{err}</p>}
        <div className="bw-actions">
          <button className="btn-ghost" onClick={() => go("board")} disabled={busy}>취소</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !valid}>{busy ? "작성 중…" : "등록"}</button>
        </div>
      </div>
    </main>
  );
}

// 좋아요 버튼 — 토글(insert/delete), UNIQUE(user_id,post_id)로 중복 차단. 비로그인은 로그인 유도.
function LikeButton({ postId, session, go }) {
  const uid = session?.user?.id;
  const [count, setCount] = useState(null);
  const [liked, setLiked] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!supabase) { setCount(0); return; }
    supabase.from("post_likes").select("id", { count: "exact", head: true }).eq("post_id", postId)
      .then(({ count, error }) => { if (alive && !error) setCount(count || 0); });
    if (uid) {
      supabase.from("post_likes").select("id").eq("post_id", postId).eq("user_id", uid).maybeSingle()
        .then(({ data }) => { if (alive) setLiked(Boolean(data)); });
    } else setLiked(false);
    return () => { alive = false; };
  }, [postId, uid]);
  const toggle = async () => {
    if (!uid) { go("app"); return; }                   // 비로그인 → 로그인 유도
    if (busy) return;
    setBusy(true);
    if (liked) {
      const { error } = await supabase.from("post_likes").delete().eq("post_id", postId).eq("user_id", uid);
      if (!error) { setLiked(false); setCount((c) => Math.max(0, (c || 0) - 1)); }
    } else {
      const { error } = await supabase.from("post_likes").insert({ post_id: postId });   // user_id=default auth.uid()
      if (!error) { setLiked(true); setCount((c) => (c || 0) + 1); }
      else if (error.code === "23505") setLiked(true);  // 이미 눌렀음(레이스) — UNIQUE
    }
    setBusy(false);
  };
  return (
    <div className="like-bar">
      <button className={`like-btn${liked ? " on" : ""}`} onClick={toggle} disabled={busy}
        aria-pressed={liked} title={uid ? (liked ? "좋아요 취소" : "좋아요") : "로그인 후 좋아요"}>
        <Heart size={18} fill={liked ? "currentColor" : "none"} />
        <span>{count == null ? "" : count}</span>
      </button>
    </div>
  );
}

// ───────── 게시판 상세 — 읽기 공개. 본인 글만 수정/삭제(RLS+UI 이중) ─────────
function BoardDetail({ id, session, go }) {
  const [post, setPost] = useState(undefined);         // undefined=로딩, null=없음, obj=글
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!supabase) { setPost(null); return; }
    supabase.from("posts").select("*").eq("id", id).maybeSingle()
      .then(({ data, error }) => { if (!alive) return; if (error) setErr(error.message); setPost(data || null); });
    return () => { alive = false; };
  }, [id]);
  if (post === undefined) return <main className="board"><p className="muted">불러오는 중…</p></main>;
  if (!post) return (
    <main className="board">
      <p className="muted">글을 찾을 수 없습니다.{err ? ` (${err})` : ""}</p>
      <button className="btn-ghost" onClick={() => go("board")}>← 게시판으로</button>
    </main>
  );
  const mine = session?.user?.id && session.user.id === post.user_id;   // 본인 글만 수정/삭제
  const edited = isEdited(post);
  const startEdit = () => { setTitle(post.title); setBody(post.body); setErr(null); setEditing(true); };
  const t = title.trim(), b = body.trim();
  const valid = t.length >= 2 && t.length <= 100 && b.length >= 1 && b.length <= 5000;
  const saveEdit = async () => {
    if (!valid) { setErr("제목 2~100자, 내용 1~5000자로 입력해 주세요."); return; }
    setBusy(true); setErr(null);
    const { data, error } = await supabase.from("posts").update({ title: t, body: b }).eq("id", id).select("*").single();
    setBusy(false);
    if (error) { setErr(error.message || "수정 실패"); return; }   // RLS가 남의 글 막음
    setPost(data); setEditing(false);                              // updated_at은 트리거가 갱신 → "수정됨"
  };
  const remove = async () => {
    if (!window.confirm("이 글을 삭제할까요? 되돌릴 수 없습니다.")) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.from("posts").delete().eq("id", id);
    setBusy(false);
    if (error) { setErr(error.message || "삭제 실패"); return; }
    go("board");
  };
  if (editing) return (
    <main className="board">
      <div className="board-head"><h1 className="board-title">글 수정</h1></div>
      <div className="bw-form">
        <input className="bw-title" placeholder="제목 (2~100자)" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="bw-body" placeholder="내용" value={body} maxLength={5000} rows={12} onChange={(e) => setBody(e.target.value)} />
        {err && <p className="fav-err">{err}</p>}
        <div className="bw-actions">
          <button className="btn-ghost" onClick={() => setEditing(false)} disabled={busy}>취소</button>
          <button className="btn-primary" onClick={saveEdit} disabled={busy || !valid}>{busy ? "저장 중…" : "저장"}</button>
        </div>
      </div>
    </main>
  );
  return (
    <main className="board">
      <button className="btn-ghost bd-back" onClick={() => go("board")}>← 목록</button>
      <article className="bd">
        <h1 className="bd-title">{post.title}</h1>
        <div className="bd-meta">
          <span className="bd-author">{post.author_nick || "익명"}</span>
          <span className="bd-date">{(post.created_at || "").slice(0, 10)}</span>
          {edited && <span className="bi-edited">수정됨 {(post.updated_at || "").slice(0, 16).replace("T", " ")}</span>}
        </div>
        {err && <p className="fav-err">{err}</p>}
        <div className="bd-body">{post.body}</div>
        <LikeButton postId={id} session={session} go={go} />
        {mine && (
          <div className="bd-actions">
            <button className="btn-ghost" onClick={startEdit} disabled={busy}>수정</button>
            <button className="btn-ghost bd-del" onClick={remove} disabled={busy}>삭제</button>
          </div>
        )}
      </article>
      <Comments postId={id} session={session} />
    </main>
  );
}

// ───────── 댓글 + 대댓글(1depth) — 읽기 공개, 본인 것만 수정/삭제(RLS+UI 이중) ─────────
function Comments({ postId, session }) {
  const uid = session?.user?.id;
  const [list, setList] = useState(null);              // null=로딩 (최상위+답글 평면 배열, parent_id로 구분)
  const [err, setErr] = useState(null);
  const [draft, setDraft] = useState("");              // 최상위 작성
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editBody, setEditBody] = useState("");
  const [replyTo, setReplyTo] = useState(null);        // 답글 폼 연 부모 댓글 id
  const [replyDraft, setReplyDraft] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());   // 답글 펼친 부모 id들(기본 접힘)
  const toggle = (id) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  useEffect(() => {
    let alive = true;
    if (!supabase) { setList([]); return; }
    supabase.from("comments").select("*").eq("post_id", postId).order("created_at", { ascending: true })
      .then(({ data, error }) => { if (!alive) return; if (error) setErr(error.message); setList(data || []); });
    return () => { alive = false; };
  }, [postId]);
  // post_id·body(+parent_id)만 — user_id·author_nick·시각은 comments_stamp 트리거가 채움
  const submit = async (body, parentId) => {
    const b = body.trim();
    if (!b) return false;
    setBusy(true); setErr(null);
    const payload = parentId ? { post_id: postId, body: b, parent_id: parentId } : { post_id: postId, body: b };
    const { data, error } = await supabase.from("comments").insert(payload).select("*").single();
    setBusy(false);
    if (error) { setErr(error.message || "등록 실패"); return false; }
    setList((cur) => [...(cur || []), data]);
    return true;
  };
  const addTop = async () => { if (await submit(draft, null)) setDraft(""); };
  const addReply = async () => {
    const pid = replyTo;
    if (await submit(replyDraft, pid)) {
      setReplyDraft(""); setReplyTo(null);
      setExpanded((s) => { const n = new Set(s); n.add(pid); return n; });   // 새 답글 보이게 자동 펼침
    }
  };
  const saveEdit = async (cid) => {
    const b = editBody.trim();
    if (!b) return;
    setBusy(true); setErr(null);
    const { data, error } = await supabase.from("comments").update({ body: b }).eq("id", cid).select("*").single();
    setBusy(false);
    if (error) { setErr(error.message || "수정 실패"); return; }   // RLS가 남의 댓글 막음
    setList((cur) => cur.map((c) => (c.id === cid ? data : c))); setEditId(null);
  };
  const del = async (cid) => {
    if (!window.confirm("삭제할까요? (답글이 있으면 함께 삭제됩니다)")) return;
    const prev = list;
    // 낙관적 제거 — 답글이면 자신만, 최상위면 그 답글들(parent_id=cid)도 함께(서버 cascade와 일치)
    setList((cur) => cur.filter((c) => c.id !== cid && c.parent_id !== cid));
    const { error } = await supabase.from("comments").delete().eq("id", cid);
    if (error) { setErr(error.message || "삭제 실패"); setList(prev); }
  };

  // 1depth 트리: 최상위(!parent_id) + parent_id별 답글. ★답글 버튼은 최상위에만 → 깊이 1단계 강제.
  const arr = Array.isArray(list) ? list : [];
  const tops = arr.filter((c) => !c.parent_id);
  const topIds = new Set(tops.map((t) => t.id));
  const repliesOf = (pid) => arr.filter((c) => c.parent_id === pid);
  const orphans = arr.filter((c) => c.parent_id && !topIds.has(c.parent_id));   // 안전망(부모 유실 시 최상위로)
  const count = arr.length;                                                     // 답글 포함

  const renderRow = (c, isReply) => {
    const mine = uid && uid === c.user_id;
    const showActions = (!isReply && uid) || mine;
    return (
      <li key={c.id} className={`cmt-item${isReply ? " cmt-reply" : ""}`}>
        <div className="cmt-meta">
          <span className="cmt-author">{c.author_nick || "익명"}</span>
          <span className="cmt-date">{(c.created_at || "").slice(0, 10)}</span>
          {isEdited(c) && <span className="bi-edited">수정됨</span>}
        </div>
        {editId === c.id ? (
          <div className="cmt-editbox">
            <textarea value={editBody} maxLength={2000} rows={3} onChange={(e) => setEditBody(e.target.value)} />
            <div className="cmt-act">
              <button className="btn-ghost" onClick={() => setEditId(null)} disabled={busy}>취소</button>
              <button className="btn-primary" onClick={() => saveEdit(c.id)} disabled={busy || !editBody.trim()}>저장</button>
            </div>
          </div>
        ) : (
          <>
            <div className="cmt-body">{c.body}</div>
            {showActions && (
              <div className="cmt-own">
                {!isReply && uid && <button onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReplyDraft(""); setErr(null); }}>답글</button>}
                {mine && <button onClick={() => { setEditId(c.id); setEditBody(c.body); setErr(null); }}>수정</button>}
                {mine && <button className="cmt-del" onClick={() => del(c.id)}>삭제</button>}
              </div>
            )}
          </>
        )}
        {!isReply && replyTo === c.id && uid && (
          <div className="cmt-replybox">
            <textarea placeholder="답글을 입력하세요" value={replyDraft} maxLength={2000} rows={2} onChange={(e) => setReplyDraft(e.target.value)} />
            <div className="cmt-act">
              <button className="btn-ghost" onClick={() => { setReplyTo(null); setReplyDraft(""); }} disabled={busy}>취소</button>
              <button className="btn-primary" onClick={addReply} disabled={busy || !replyDraft.trim()}>답글 등록</button>
            </div>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="cmt">
      <h2 className="cmt-h">댓글 {count > 0 && <span className="mp-cnt">{count}</span>}</h2>
      {err && <p className="fav-err">{err}</p>}
      {list === null ? <p className="muted">불러오는 중…</p>
        : count === 0 ? <p className="muted">아직 댓글이 없습니다.</p>
        : (
          <ul className="cmt-list">
            {tops.map((t) => {
              const reps = repliesOf(t.id);
              const open = expanded.has(t.id);
              return [
                renderRow(t, false),
                reps.length > 0 && (
                  <li key={t.id + "_tg"} className="cmt-togglerow">
                    <button className="cmt-toggle" onClick={() => toggle(t.id)}>
                      {open ? "답글 숨기기 ▴" : `답글 ${reps.length}개 보기 ▾`}
                    </button>
                  </li>
                ),
                ...(open ? reps.map((r) => renderRow(r, true)) : []),
              ];
            })}
            {orphans.map((o) => renderRow(o, false))}
          </ul>
        )}
      {uid ? (
        <div className="cmt-write">
          <textarea placeholder="댓글을 입력하세요" value={draft} maxLength={2000} rows={3} onChange={(e) => setDraft(e.target.value)} />
          <div className="cmt-act">
            <button className="btn-primary" onClick={addTop} disabled={busy || !draft.trim()}>{busy ? "등록 중…" : "댓글 등록"}</button>
          </div>
        </div>
      ) : <p className="muted cmt-login">댓글을 쓰려면 로그인하세요.</p>}
    </section>
  );
}

export default function App() {
  const [view, setView] = useState(() => window.location.hash.replace("#", "") || "home");
  const [session, setSession] = useState(null);
  const [pendingAddr, setPendingAddr] = useState(null);   // 마이페이지→검색 분석 연결용
  const [nick, setNick] = useState(undefined);            // undefined=로딩, null=미설정(게이트), 문자열=설정됨
  useEffect(() => {
    const on = () => setView(window.location.hash.replace("#", "") || "home");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {                                    // ★Supabase 세션 구독
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => {                                    // ★로그인 시 닉네임 조회 — 없으면 설정 게이트
    if (!supabase || !session) { setNick(undefined); return; }
    let alive = true;
    supabase.from("profiles").select("nickname").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => { if (alive) setNick(data?.nickname || null); });   // 빈값/NULL → null(미설정)
    return () => { alive = false; };
  }, [session]);
  const go = (v) => { window.location.hash = v; setView(v); window.scrollTo(0, 0); };
  const logout = async () => { if (supabase) await supabase.auth.signOut(); go("home"); };
  const openReport = (address) => { setPendingAddr(address); go("app"); };   // 마이페이지 항목 → 검색 분석

  const [page, sub] = view.split("/");                // ★해시 파싱: "board/123" → page="board", sub="123"
  const needAuth = view === "app" && !session;        // ★게이트: 검색은 로그인 필수
  const body = needAuth ? <AuthPage onAuthed={() => go("app")} go={go} />
    : view === "app" ? (
        nick === undefined ? <main className="doc auth"><div className="auth-card"><p className="muted">불러오는 중…</p></div></main>
        : !nick ? <NicknameSetup uid={session.user.id} onDone={(v) => setNick(v)} logout={logout} />   // ★닉네임 없으면 설정(스킵 불가)
        : <Workspace session={session} pendingAddr={pendingAddr} onConsumePending={() => setPendingAddr(null)} />)
    : view === "mypage" ? (session ? <MyPage session={session} openReport={openReport} go={go} /> : <AuthPage onAuthed={() => go("mypage")} go={go} />)
    : page === "board" ? (sub === "new" ? <BoardWrite session={session} nick={nick} go={go} />   // #board/new = 작성
        : sub ? <BoardDetail id={sub} session={session} go={go} />                                 // #board/<id> = 상세
        : <BoardList session={session} go={go} />)                                                // #board = 목록
    : view === "guide" ? <Guide go={go} />
    : ["terms", "privacy", "disclaimer"].includes(view) ? <Legal kind={view} />
    : <Landing go={go} />;
  const fullApp = view === "app" && !needAuth && !!nick;   // 풀높이 지도 = 로그인 + 닉네임 설정 후에만(게이트/로딩은 일반 레이아웃)
  return (
    <div className={`site ${fullApp ? "is-app" : ""}`}>
      <Header view={view} go={go} session={session} logout={logout} />
      {body}
      {!fullApp && <Footer go={go} />}
    </div>
  );
}
