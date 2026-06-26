import React, { useState, useEffect } from "react";
import { MapContainer, TileLayer, CircleMarker, Marker, useMapEvents, useMap } from "react-leaflet";
import { supabase, authReady, authedFetch } from "./supabase";
import { MapPin, Map as MapIcon, FileText, KeyRound, ShieldCheck, ArrowRight } from "lucide-react";

const SEOUL = [37.55, 126.99];
// ★색 = 재개발 환경 유사도 백분위. 빨강(높음=재개발된 동네와 닮음) → 초록(낮음=거리 멂).
const color = (pct) => `hsl(${(1 - pct) * 120}, 80%, 45%)`;
// 유사도 등급(백분위 → 높음/중간/낮음). rank_top_pct: 작을수록 상위(닮음).
const simGrade = (pct) => (pct == null ? null : pct <= 33 ? "높음" : pct <= 66 ? "중간" : "낮음");

// ★렌더 절제: 화면 영역(bbox) 필지만 — moveend마다 /screen/bbox 조회. 점 색으로 환경 유사도 표현.
// ★군집 외곽선(점선)은 제거 — 볼록껍질이 도로·공원을 가로질러 '재개발 구역 경계'로 오독 위험(근거 약함).
function BboxLayer() {
  const [pts, setPts] = useState([]);
  const fetchBbox = async (map) => {
    const b = map.getBounds();
    const q = `west=${b.getWest()}&south=${b.getSouth()}&east=${b.getEast()}&north=${b.getNorth()}&limit=1500`;
    if (map.getZoom() < 13) { setPts([]); return; } // 줌 낮으면 생략(통짜 렌더 금지)
    // ★/report·/screen과 동일하게 authedFetch로 Bearer 토큰 부착(401 해소).
    // authedFetch엔 공통 401 처리가 없어 — 토큰 만료 등으로 401/실패 시 조용히 색점만 미표시(앱 안 죽게).
    try {
      const r = await authedFetch(`/screen/bbox?${q}`);
      if (!r.ok) return;
      const d = await r.json();
      setPts(d.results || []);
    } catch { /* 네트워크·인증 실패 — 무시 */ }
  };
  const map = useMapEvents({ moveend: () => fetchBbox(map) });
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
function SimilarHero({ matches }) {
  const [top, ...rest] = matches;
  return (
    <section className="sim">
      <h2 className="sim-title">이 동네는 재개발로 진행된 동네와 닮았습니다</h2>
      <div className="sim-top">
        <div className="sim-pct">{Math.round(top.similarity * 100)}<small>%</small></div>
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
              <div className="sim-meta-s">{Math.round(m.similarity * 100)}% 닮음{statusText(m) ? ` · ${statusText(m)}` : ""}</div>
            </div>
          ))}
        </div>
      )}
      <p className="sim-disc">재개발이 진행된 실제 동네와 얼마나 닮았는지를 보여줍니다. 닮음이 곧 재개발 확정은 아닙니다.</p>
    </section>
  );
}

// 왜 닮았나 — top_similar_axes에 든 축만 + query_metrics 입력값(매치 수치는 API에 없음 → 비교 안 함).
const _AXIS = { "노후도": ["old_area_ratio", "%", 100], "면적": ["area_ha", "ha", 1], "호수밀도": ["house_density", "", 1], "접도율": ["abut_ratio", "%", 100] };
function WhySimilar({ retrieval }) {
  const axes = retrieval?.matches?.[0]?.top_similar_axes || [];
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

function ReportPanel({ r }) {
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
function Workspace() {
  const [tab, setTab] = useState("search");
  const [addr, setAddr] = useState("성북구 정릉동 170-1");
  const [report, setReport] = useState(null);
  const [pos, setPos] = useState(null);
  const search = () => {
    setReport({ loading: true });
    /* ★stage 하드코딩 금지(누수 경로) — 실제 단계를 모르면 보내지 않는다. in_zone+stage일 때만 '언제' 출력 */
    authedFetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: addr, property_type: "다세대" }) })
      .then((r) => r.json())
      .then((r) => { setReport(r); if (r.lat) setPos([r.lat, r.lon]); })
      .catch((e) => setReport({ error: String(e) }));
  };
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
              <button onClick={search}>분석</button>
            </div>
            {report?.loading ? <p className="muted">분석 중…</p> : <ReportPanel r={report} />}
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

const BRAND = "재개발 투자 판단";
const NAV = [{ id: "home", label: "소개" }, { id: "guide", label: "이용방법" }, { id: "app", label: "검색" }];
const FEATURES = [
  { Icon: MapPin, t: "주소로 환경 분석", d: "지번 하나로 그 일대의 노후 환경 유사도와 재개발 요건 충족 여부를 정리해 봅니다." },
  { Icon: MapIcon, t: "지도 시각화", d: "일대 필지의 환경 점수를 색으로 표시합니다. 구역 경계가 아닌 참고용 분포입니다." },
  { Icon: FileText, t: "계획정보 근거", d: "지정 정비구역이면 용적률·세대수 등을 고시문 출처와 함께 인용합니다." },
  { Icon: KeyRound, t: "진입 가능성", d: "토지거래허가 등 규제를 참고로 제시합니다. 수시 변경되니 사용 시점 고시 확인이 필요합니다." },
];

function Header({ view, go, session, logout }) {
  return (
    <header className="site-h">
      <div className="brand" onClick={() => go("home")} role="button">
        <span className="logo">▦</span>
        <span className="brand-name">{BRAND}</span>
        <span className="brand-tag">데이터 기반 재개발 환경 분석</span>
      </div>
      <div className="h-right">
        <nav className="site-nav">
          {NAV.map((n) => <button key={n.id} className={view === n.id ? "on" : ""} onClick={() => go(n.id)}>{n.label}</button>)}
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
  if (!authReady) return (
    <main className="doc"><div className="legal-banner">인증이 아직 설정되지 않았습니다 — <b>.env</b>의
      <code> VITE_SUPABASE_URL</code>·<code>VITE_SUPABASE_ANON_KEY</code>를 넣고 재기동하세요(Supabase 셋업 후).</div></main>
  );
  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      if (mode === "signup") {
        if (!agree) { setMsg("개인정보(이메일) 수집·이용에 동의해야 가입할 수 있습니다."); setBusy(false); return; }
        const { error } = await supabase.auth.signUp({ email, password: pw });
        if (error) throw error;
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
          <label className="auth-agree">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>[필수] 개인정보(이메일) 수집·이용 동의 — <a onClick={() => go("privacy")}>개인정보처리방침</a> · <a onClick={() => go("disclaimer")}>면책</a> (초안)</span>
          </label>
        )}
        <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? "처리 중…" : title}</button>
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

export default function App() {
  const [view, setView] = useState(() => window.location.hash.replace("#", "") || "home");
  const [session, setSession] = useState(null);
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
  const go = (v) => { window.location.hash = v; setView(v); window.scrollTo(0, 0); };
  const logout = async () => { if (supabase) await supabase.auth.signOut(); go("home"); };

  const needAuth = view === "app" && !session;        // ★게이트: 검색은 로그인 필수
  const body = needAuth ? <AuthPage onAuthed={() => go("app")} go={go} />
    : view === "app" ? <Workspace />
    : view === "guide" ? <Guide go={go} />
    : ["terms", "privacy", "disclaimer"].includes(view) ? <Legal kind={view} />
    : <Landing go={go} />;
  const fullApp = view === "app" && !needAuth;        // 풀높이 지도 레이아웃은 로그인 후에만
  return (
    <div className={`site ${fullApp ? "is-app" : ""}`}>
      <Header view={view} go={go} session={session} logout={logout} />
      {body}
      {!fullApp && <Footer go={go} />}
    </div>
  );
}
