"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Brand, Dialog, Toast } from "@/components/ui";
import { FlagKR, FlagUS } from "@/components/flags";
import { IcArrowDown, IcArrowLeft, IcArrowRight, IcMoreVert, IcReload, IcSearch } from "@/components/icons";
import {
  cancelIssue,
  checkEmail,
  createAccount,
  getSummary,
  listAccounts,
  logout,
  resendGuide,
  type Account,
  type AccountStatus,
  type AccountSummary,
  type EmailCheck,
  type MailFailureReason,
  type MailLanguage,
  type ResendFailure,
} from "@/lib/api";
import { useStaff } from "@/lib/session";

const COMPANY_MAX = 40;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LANGUAGES: { value: MailLanguage; label: string; Flag: () => React.ReactElement }[] = [
  { value: "en", label: "English", Flag: FlagUS },
  { value: "ko", label: "한국어", Flag: FlagKR },
];
const languageName = (l: MailLanguage) => (l === "en" ? "English" : "한국어");
/** 휴대폰 카드용 짧은 표기 */
const languageShort = (l: MailLanguage) => (l === "en" ? "EN" : "KO");
const STATUS_LABEL: Record<AccountStatus, string> = { pending: "첫 로그인 전", in_use: "사용 중", cancelled: "발급 취소" };

function kstParts(iso: string) {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return { y: p("year"), m: p("month"), d: p("day"), h: p("hour"), min: p("minute") };
}
const fmtFull = (iso: string) => {
  const t = kstParts(iso);
  return `${t.y}.${t.m}.${t.d} ${t.h}:${t.min}`;
};
const fmtShort = (iso: string) => {
  const t = kstParts(iso);
  return `${t.m}.${t.d} ${t.h}:${t.min}`;
};
/** 직원은 이름 대신 회사 이메일로 구분해요. 목록 · 안내에는 @ 앞부분만. */
const handle = (email: string) => email.split("@")[0];
const fmtMonthDay = (iso: string) => {
  const t = kstParts(iso);
  return `${t.m}.${t.d}`;
};

/** 발급 취소 줄: 누가 · 언제 취소했는지 */
const cancelNote = (a: Account) => `${handle(a.cancelledBy ?? "")} 취소 · ${a.cancelledAt ? fmtShort(a.cancelledAt) : ""}`;

type ToastState = { title: string; detail: string } | null;

const CHECK_FAILED = "이메일을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
const LOAD_FAILED = "목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";

/** 목록 줄 상태: 안내 메일을 보내지 못한 첫 로그인 전 계정은 까닭을 빨간 글씨로 보여 줘요(필터 · 요약은 그대로 「첫 로그인 전」). */
const MAIL_FAILURE_LABEL: Record<MailFailureReason, string> = {
  temporary: "일시적 발송 오류",
  address: "이메일 주소 오류",
  unknown: "메일 발송 실패",
};

/** 만들기 · 다시 보내기 직후 창에 보여 주는 실패 까닭(I · I2 · J · K, 휴대폰 M6–M9) */
const MAIL_FAILURE_TEXT: Record<MailFailureReason | "blocked", string> = {
  temporary: "일시적인 오류로 안내 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.",
  address: "유효하지 않은 이메일 주소입니다.",
  unknown: "안내 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.",
  // TODO(UG-405): 문구 기획 확인 필요
  blocked: "같은 주소로 여러 번 보내지 못해 다시 보내기를 막았습니다. 주소를 확인하고 발급 취소해 주세요.",
};

/** 메일 서버가 받지 않아 보내지 못한 경우(다시 누르기보다 까닭을 보여 줄 것) */
const isMailFailure = (r: ResendFailure): r is MailFailureReason | "blocked" =>
  r === "temporary" || r === "address" || r === "unknown" || r === "blocked";

/** 다시 보내기 실패 안내 — 그사이 고객이 로그인했거나 발급이 취소됐으면 그대로 알려요. */
const resendErrorText = (reason: ResendFailure) =>
  isMailFailure(reason)
    ? MAIL_FAILURE_TEXT[reason]
    : reason === "in_use"
      ? "고객이 이미 로그인해서 다시 보낼 수 없습니다. 목록에서 「사용 중」으로 바뀝니다."
      : reason === "not_found"
        ? "발급이 취소된 계정입니다. 목록을 새로 고쳐 주세요."
        : "안내 메일을 보내지 못했습니다. 다시 시도해 주세요.";

/** 주소 오류(막힌 경우 포함)면 실패 창에서 바로 발급 취소로 이어 줘요. */
const offersCancel = (reason: MailFailureReason | "blocked") => reason === "address" || reason === "blocked";

/** 첫 로그인 전이고 서버가 막지 않았으면 다시 보낼 수 있어요. */
const canResend = (a: Account) => a.status === "pending" && !a.resendBlocked;

export default function AccountsPage() {
  const router = useRouter();
  const staff = useStaff();

  const [rows, setRows] = useState<Account[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // 검색 칸 값(keyword · status)과 실제로 조회한 조건(applied)을 나눠요 — 검색을 눌러야 목록이 바뀌어요.
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<AccountStatus | "all">("all");
  const [applied, setApplied] = useState<{ keyword: string; status: AccountStatus | "all" }>({ keyword: "", status: "all" });
  const [version, setVersion] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [resendTarget, setResendTarget] = useState<Account | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Account | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [freshId, setFreshId] = useState<string | null>(null);

  // 로그인 확인. 화면 이동용이고, 실제 권한 검사는 서버가 해요(로그인이 끊기면 서버 호출이 로그인 화면으로 보내요).
  useEffect(() => {
    if (staff === null) router.replace("/login");
  }, [staff, router]);

  /** 지금 조건 그대로 목록 · 요약을 다시 불러와요. */
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // 목록은 서버가 한 페이지씩 줘요. 조건 · 페이지 · 페이지 크기가 바뀌거나 reload 하면 다시 불러와요.
  useEffect(() => {
    if (!staff) return;
    let alive = true;
    // 요약이 실패해도 목록은 보여 줘요(요약은 전 값을 그대로 둬요).
    getSummary()
      .then((sum) => alive && setSummary(sum))
      .catch(() => {});
    listAccounts({ ...applied, page, size: pageSize })
      .then((list) => {
        if (!alive) return;
        // 마지막 페이지의 마지막 줄이 빠졌으면(발급 취소 · 필터) 남은 마지막 페이지로 옮겨 다시 불러요.
        const last = Math.max(1, Math.ceil(list.total / pageSize));
        if (list.items.length === 0 && page > last) {
          setPage(last);
          return;
        }
        setRows(list.items);
        setTotal(list.total);
        setLoadError(false);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    return () => {
      alive = false;
    };
  }, [staff, applied, page, pageSize, version]);

  const metrics = summary ?? { total: 0, pending: 0, inUse: 0, cancelled: 0, thisMonth: 0 };

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const visible = rows;
  const from = total ? (current - 1) * pageSize + 1 : 0;
  const to = Math.min(current * pageSize, total);
  const emptyText = loadError
    ? LOAD_FAILED
    : !loaded
      ? "불러오는 중…"
      : metrics.total === 0
        ? "아직 만든 Gate 계정이 없습니다."
        : "검색 결과가 없습니다.";

  function onSearch(e?: React.FormEvent) {
    e?.preventDefault();
    setPage(1);
    setApplied({ keyword, status });
    reload();
  }

  function onReset() {
    setKeyword("");
    setStatus("all");
    setPage(1);
    setApplied({ keyword: "", status: "all" });
    reload();
  }

  /** 새로 만든 계정이 보이도록 조건을 풀고 첫 페이지를 다시 불러와 그 줄을 잠깐 표시해요. */
  const showCreated = useCallback(
    (account: Account) => {
      setKeyword("");
      setStatus("all");
      setPage(1);
      setApplied({ keyword: "", status: "all" });
      reload();
      setFreshId(account.id);
    },
    [reload],
  );

  const afterSend = useCallback(
    (result: { kind: "created"; account: Account } | { kind: "resent" }) => {
      setCreating(false);
      setResendTarget(null);
      if (result.kind === "created") {
        showCreated(result.account);
        setToast({ title: "계정을 만들었습니다", detail: "안내 메일 발송을 요청했습니다" });
      } else {
        reload();
        setToast({ title: "안내 메일을 다시 보냈습니다", detail: "새 임시 비밀번호로 발송을 요청했습니다" });
      }
    },
    [reload, showCreated],
  );

  /** 실패 창의 「발급 취소」: 지금 창을 닫고 발급 취소 확인 창(H)을 열어요. */
  const openCancel = useCallback((account: Account) => {
    setCreating(false);
    setResendTarget(null);
    setCancelTarget(account);
  }, []);

  useEffect(() => {
    if (!freshId) return;
    const t = setTimeout(() => setFreshId(null), 4000);
    return () => clearTimeout(t);
  }, [freshId]);

  const clearToast = useCallback(() => setToast(null), []);

  const afterCancel = useCallback(() => {
    setCancelTarget(null);
    reload();
    setToast({ title: "발급을 취소했습니다", detail: "같은 이메일로 다시 발급할 수 있습니다" });
  }, [reload]);

  // 취소하지 못한 경우(고객이 이미 로그인)도 목록은 새로 불러와 「사용 중」으로 보여 줘요.
  const closeCancel = useCallback(() => {
    setCancelTarget(null);
    reload();
  }, [reload]);

  if (!staff) return null;

  return (
    <>
      <header className="app-nav">
        <div className="app-nav-left">
          <Brand />
          <nav className="app-menu" aria-label="메뉴">
            <a className="app-menu-item is-active" href="/accounts" aria-current="page">
              계정 발급
            </a>
          </nav>
        </div>
        <ProfileMenu
          email={staff.email}
          onLogout={() => {
            logout();
            router.replace("/login");
          }}
        />
      </header>

      <div className="breadcrumb">
        <span>BACKOFFICE</span>
        <IcArrowRight size={14} className="breadcrumb-sep" />
        <span className="breadcrumb-current">계정 발급</span>
      </div>

      <main className="content">
        <div className="page-title">
          <h1 className="t-heading-300">계정 발급</h1>
          <button type="button" className="btn btn-dark btn-sm" onClick={() => setCreating(true)}>
            계정 만들기
          </button>
        </div>

        <section className="overview" aria-label="요약">
          <Metric label="전체" value={metrics.total} sub={`이번 달 ${metrics.thisMonth}개`} />
          <Metric label="첫 로그인 전" value={metrics.pending} sub="안내 메일을 다시 보낼 수 있음" />
          <Metric label="사용 중" value={metrics.inUse} sub="고객이 콘솔에 로그인함" />
          <Metric label="발급 취소" value={metrics.cancelled} sub="계정 · 데모 프로젝트 삭제됨" />
        </section>

        <form className="toolbar" onSubmit={onSearch} role="search">
          <label className="search">
            <IcSearch size={16} className="search-icon" />
            <span className="visually-hidden">검색어</span>
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="회사명, 고객 이메일 검색" />
          </label>
          <label className="select">
            <span className="visually-hidden">상태</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as AccountStatus | "all")}>
              <option value="all">상태 전체</option>
              <option value="pending">첫 로그인 전</option>
              <option value="in_use">사용 중</option>
              <option value="cancelled">발급 취소</option>
            </select>
            <IcArrowDown size={16} className="select-icon" />
          </label>
          <button type="submit" className="btn btn-dark btn-sm">
            검색
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={onReset}>
            초기화
          </button>
          <span className="count">총 {total}개</span>
          {loadError && rows.length > 0 && (
            <span className="error" role="alert">
              {LOAD_FAILED}
            </span>
          )}
        </form>

        {/* PC: 표 */}
        <div className="table" role="table" aria-label="발급한 계정">
          <div className="tr th" role="row">
            {["회사명", "고객 이메일", "메일 언어", "상태", "생성자", "생성일시", "관리"].map((h) => (
              <span key={h} role="columnheader">
                {h}
              </span>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className="empty">{emptyText}</p>
          ) : (
            visible.map((a) => (
              <div key={a.id} className={`tr${a.id === freshId ? " is-new" : ""}`} role="row">
                <span role="cell">{a.company}</span>
                <span role="cell">{a.email}</span>
                <span role="cell">{languageName(a.language)}</span>
                <span role="cell">
                  <Status account={a} />
                </span>
                <span role="cell">{handle(a.createdBy)}</span>
                <span role="cell">{fmtFull(a.createdAt)}</span>
                <span role="cell">
                  {a.status === "pending" ? (
                    <span className="row-actions">
                      {canResend(a) && (
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => setResendTarget(a)}>
                          안내 메일 다시 보내기
                        </button>
                      )}
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setCancelTarget(a)}>
                        발급 취소
                      </button>
                    </span>
                  ) : a.status === "cancelled" ? (
                    <span className="cancel-note">{cancelNote(a)}</span>
                  ) : (
                    <span className="dash">—</span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>

        {/* 휴대폰: 줄마다 카드 */}
        <ul className="cards" aria-label="발급한 계정">
          {visible.length === 0 && (
            <li className="empty">{emptyText}</li>
          )}
          {visible.map((a) => (
            <li key={a.id} className={`card-row${a.id === freshId ? " is-new" : ""}`}>
              <div className="card-line">
                <strong className="card-company">{a.company}</strong>
                <span className="card-status">
                  <Status account={a} />
                  {/* 드물게 쓰는 「발급 취소」는 더보기 안에 — 자주 쓰는 재발송만 카드에 보여요 */}
                  {a.status === "pending" && <CardMore onCancel={() => setCancelTarget(a)} />}
                </span>
              </div>
              <div className="card-line">
                <span className="card-email">{a.email}</span>
                {canResend(a) && (
                  <button type="button" className="link-action" onClick={() => setResendTarget(a)}>
                    <IcReload size={14} />
                    재발송
                  </button>
                )}
                {/* 발급 취소 줄: 다시 보내기 자리에 누가 · 언제 */}
                {a.status === "cancelled" && <span className="cancel-note">{cancelNote(a)}</span>}
              </div>
              <div className="card-line">
                <span className="card-meta">
                  {languageShort(a.language)} · {handle(a.createdBy)} · {fmtShort(a.createdAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>

        {total > 0 && (
          <nav className="pagination" aria-label="페이지">
            <span className="pagination-range">
              {from}–{to} / {total}개
            </span>
            <div className="pages">
              <button type="button" className="page-btn" onClick={() => setPage(current - 1)} disabled={current <= 1} aria-label="이전 페이지">
                <IcArrowLeft size={16} />
              </button>
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`page-btn${n === current ? " is-current" : ""}`}
                  aria-current={n === current ? "page" : undefined}
                  onClick={() => setPage(n)}
                >
                  {n}
                </button>
              ))}
              <button
                type="button"
                className="page-btn"
                onClick={() => setPage(current + 1)}
                disabled={current >= pageCount}
                aria-label="다음 페이지"
              >
                <IcArrowRight size={16} />
              </button>
            </div>
            <label className="page-size">
              <span className="visually-hidden">한 페이지에 보기</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
              >
                {[10, 20, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}개씩 보기
                  </option>
                ))}
              </select>
              <IcArrowDown size={16} className="select-icon" />
            </label>
          </nav>
        )}
      </main>

      {creating && (
        <CreateDialog
          onClose={() => {
            setCreating(false);
            reload();
          }}
          onCreated={(account) => afterSend({ kind: "created", account })}
          onMailFailed={showCreated}
          onResent={() => afterSend({ kind: "resent" })}
          onResendMailFailed={reload}
          onCancelIssue={openCancel}
        />
      )}

      {resendTarget && (
        <ResendDialog
          account={resendTarget}
          onClose={() => {
            setResendTarget(null);
            reload();
          }}
          onResent={() => afterSend({ kind: "resent" })}
          onMailFailed={reload}
          onCancelIssue={openCancel}
        />
      )}

      {cancelTarget && <CancelDialog account={cancelTarget} onClose={closeCancel} onCancelled={afterCancel} />}

      {toast && <Toast title={toast.title} detail={toast.detail} onDone={clearToast} />}
    </>
  );
}

/** 오른쪽 위 프로필. 누르면 로그아웃이 있는 작은 메뉴가 열려요(휴대폰은 이메일도 메뉴 안에). */
/** 휴대폰 카드 더보기(⋮) — 「발급 취소」. 프로필 메뉴와 같은 어두운 유리. */
function CardMore({ onCancel }: { onCancel: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="card-more" ref={ref}>
      <button type="button" className="card-more-button" aria-label="더보기" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IcMoreVert size={18} />
      </button>
      {open && (
        <div className="profile-menu card-more-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="profile-menu-item"
            onClick={() => {
              setOpen(false);
              onCancel();
            }}
          >
            발급 취소
          </button>
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="profile" ref={ref}>
      <button type="button" className="profile-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="avatar" aria-hidden="true">
          {email.slice(0, 1).toUpperCase()}
        </span>
        <span className="identity-name">{email}</span>
      </button>
      {open && (
        <div className="profile-menu" role="menu">
          <p className="profile-menu-email">{email}</p>
          <button type="button" role="menuitem" className="profile-menu-item" onClick={onLogout}>
            로그아웃
          </button>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <div>
        <strong className="metric-value">{value}</strong>
        <span className="metric-sub">{sub}</span>
      </div>
    </div>
  );
}

function Status({ account }: { account: Account }) {
  const failure = account.status === "pending" ? account.mailFailureReason : undefined;
  return (
    <span className={`status status--${failure ? "mail-failed" : account.status}`}>
      <span className="status-dot" aria-hidden="true" />
      {failure ? MAIL_FAILURE_LABEL[failure] : STATUS_LABEL[account.status]}
    </span>
  );
}

/** 실패 안내 한 줄. 문장 사이에서만 줄이 바뀌어요(PC 는 한 줄, 휴대폰은 문장마다). */
function MailFailureMessage({ reason }: { reason: MailFailureReason | "blocked" }) {
  const sentences = MAIL_FAILURE_TEXT[reason].split(". ");
  return (
    <p className="error mail-failure" role="alert">
      {sentences.map((s, i) => (
        <span key={i} className="mail-failure-sentence">
          {i > 0 && " "}
          {i < sentences.length - 1 ? `${s}.` : s}
        </span>
      ))}
    </p>
  );
}

/**
 * 안내 메일을 보내지 못했을 때 창 안에 보여 주는 결과(I · I2 · J · K).
 * 일시 오류 · 그 밖의 실패는 「닫기」만 — 다시 보내기는 목록에서 해요. 주소 오류는 「발급 취소」로 이어 줘요.
 */
function MailFailureResult({
  account,
  reason,
  onClose,
  onCancelIssue,
}: {
  account: Account;
  reason: MailFailureReason | "blocked";
  onClose: () => void;
  onCancelIssue: (a: Account) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  // 입력 칸 · 보내기 버튼이 사라지므로 초점을 「닫기」로 옮겨요.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <>
      <div className="summary">
        <div className="summary-target">
          <strong>{account.company}</strong>
          <span>{account.email}</span>
        </div>
      </div>
      <MailFailureMessage reason={reason} />
      <div className="dialog-actions">
        <button ref={closeRef} type="button" className="btn btn-outline" onClick={onClose}>
          닫기
        </button>
        {offersCancel(reason) && (
          <button type="button" className="btn btn-danger-outline" onClick={() => onCancelIssue(account)}>
            발급 취소
          </button>
        )}
      </div>
    </>
  );
}

/**
 * 「계정 만들기」 창(B · C · D). 보내기 전 확인은 이 창 하나로 해요.
 * 첫 로그인 전 이메일이면 이 창에서 다시 보내요 — 실패하면 목록의 다시 보내기 창(F)과 같은 결과(J · K)를 보여 줘요.
 */
function CreateDialog({
  onClose,
  onCreated,
  onMailFailed,
  onResent,
  onResendMailFailed,
  onCancelIssue,
}: {
  onClose: () => void;
  onCreated: (a: Account) => void;
  /** 계정은 만들었지만 메일은 못 보냄 — 창은 닫지 않고 결과를 보여 줘요(목록만 새로 고침) */
  onMailFailed: (a: Account) => void;
  onResent: () => void;
  /** 첫 로그인 전 계정에 다시 보냈지만 메일은 못 보냄(막힌 경우 포함) — 창은 닫지 않고 목록만 새로 고쳐요 */
  onResendMailFailed: () => void;
  onCancelIssue: (a: Account) => void;
}) {
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [language, setLanguage] = useState<MailLanguage>("en");
  const [companyError, setCompanyError] = useState("");
  const [emailError, setEmailError] = useState("");
  const [formError, setFormError] = useState("");
  const [check, setCheck] = useState<{ email: string; result: EmailCheck } | null>(null);
  const [sending, setSending] = useState(false);
  const [mailFailure, setMailFailure] = useState<{ account: Account; reason: MailFailureReason | "blocked" } | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const companyRef = useRef<HTMLInputElement>(null);

  const trimmed = email.trim();
  const key = trimmed.toLowerCase();
  const current = check && check.email === key ? check.result : null;
  const pending = current?.status === "pending" ? current : null;
  const inUse = current?.status === "in_use";
  // 주소 오류가 3번 이어져 서버가 다시 보내기를 막은 계정 — 다시 보내기 대신 발급 취소를 안내해요(목록과 같은 규칙)
  const blocked = pending?.resendBlocked === true;

  /**
   * 실패 결과 · 발급 취소 창에 넘길 대상(첫 로그인 전 발급 기록).
   * 미리 조회는 회사명을 주지 않아 입력한 회사명을 보여 줘요(아직 비었으면 —). 발급 취소는 기록 번호(id)로 해요.
   */
  const pendingTarget = (p: Extract<EmailCheck, { status: "pending" }>): Account => ({
    id: p.id,
    company: company.trim() || "—",
    email: trimmed,
    language: p.language,
    status: "pending",
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    resendBlocked: p.resendBlocked,
  });

  async function runCheck(): Promise<EmailCheck | null> {
    if (!EMAIL_RE.test(trimmed)) return null;
    if (current) return current;
    const asked = key;
    let result: EmailCheck;
    try {
      result = await checkEmail(trimmed);
    } catch {
      if (emailRef.current?.value.trim().toLowerCase() === asked) setEmailError(CHECK_FAILED);
      return null;
    }
    // 조회하는 사이 이메일을 고쳤으면 버려요.
    if (emailRef.current?.value.trim().toLowerCase() !== asked) return null;
    setCheck({ email: asked, result });
    // 첫 로그인 전이면 메일 언어를 처음 보낸 언어로 미리 골라 둬요.
    if (result.status === "pending") setLanguage(result.language);
    return result;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    let cError = "";
    let eError = "";
    if (!company.trim()) cError = "회사명을 입력해 주세요.";
    else if (company.trim().length > COMPANY_MAX) cError = `회사명은 ${COMPANY_MAX}자까지 쓸 수 있습니다.`;
    if (!trimmed) eError = "고객 이메일을 입력해 주세요.";
    else if (!EMAIL_RE.test(trimmed)) eError = "이메일 형식을 확인해 주세요.";
    setCompanyError(cError);
    setEmailError(eError);
    setFormError("");
    if (cError) return companyRef.current?.focus();
    if (eError) return emailRef.current?.focus();

    // 아직 조회 전이면 먼저 조회해요. 상태가 새로 드러나면 보내지 않고 칸 아래에 먼저 보여 줘요.
    let state = current;
    if (!state) {
      state = await runCheck();
      if (!state || state.status !== "new") return emailRef.current?.focus();
    }
    if (state.status === "in_use") return;
    // 막힌 계정은 다시 보내지 않아요 — 창에 「닫기」 · 「발급 취소」만 있어요(Enter 로 제출해도 그대로).
    if (state.status === "pending" && state.resendBlocked) return;

    setSending(true);
    const input = { company: company.trim(), email: trimmed, language };
    if (state.status === "pending") {
      const res = await resendGuide(state.id, language);
      setSending(false);
      if (res.ok) return onResent();
      if (isMailFailure(res.reason)) {
        // 목록의 다시 보내기 창과 같이: 까닭을 보여 주고(주소 오류 · 막힘은 발급 취소로 이어 줘요) 목록을 새로 고쳐요.
        setMailFailure({ account: pendingTarget(state), reason: res.reason });
        return onResendMailFailed();
      }
      setFormError(resendErrorText(res.reason));
      if (res.reason === "in_use" || res.reason === "not_found") setCheck(null); // 상태가 바뀌었어요 — 칸을 벗어나면 다시 조회해요
      return;
    }
    const res = await createAccount(input);
    setSending(false);
    if (res.ok) {
      if (res.mailSent) return onCreated(res.account);
      setMailFailure({ account: res.account, reason: res.mailFailureReason });
      return onMailFailed(res.account);
    }
    if (res.reason === "duplicate" || res.reason === "in_use") {
      // 조회와 보내기 사이에 상태가 바뀐 경우: 다시 조회해서 칸 아래에 보여 줘요.
      try {
        const result = await checkEmail(trimmed);
        setCheck({ email: key, result });
        if (result.status === "pending") setLanguage(result.language);
      } catch {
        setEmailError(CHECK_FAILED);
      }
      emailRef.current?.focus();
    } else setFormError("계정을 만들지 못했습니다. 다시 시도해 주세요.");
  }

  if (mailFailure) {
    return (
      <Dialog title="Gate 계정 만들기" onClose={onClose}>
        <MailFailureResult account={mailFailure.account} reason={mailFailure.reason} onClose={onClose} onCancelIssue={onCancelIssue} />
      </Dialog>
    );
  }

  return (
    <Dialog title="Gate 계정 만들기" onClose={onClose} closable={!sending}>
      <form className="dialog-form" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label htmlFor="company" className="t-body-200-b">
            회사명
          </label>
          <div className={`input-box${companyError ? " is-error" : ""}`}>
            <input
              ref={companyRef}
              id="company"
              autoComplete="organization"
              value={company}
              onChange={(e) => {
                setCompany(e.target.value);
                if (companyError) setCompanyError("");
              }}
              aria-invalid={!!companyError}
              aria-describedby={companyError ? "company-error" : undefined}
            />
          </div>
          {companyError && (
            <p id="company-error" className="error">
              {companyError}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="email" className="t-body-200-b">
            고객 이메일
          </label>
          <div className={`input-box${emailError || inUse ? " is-error" : ""}`}>
            <input
              ref={emailRef}
              id="email"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (emailError) setEmailError("");
              }}
              onBlur={() => void runCheck()}
              aria-invalid={!!emailError || inUse}
              aria-describedby="email-note"
            />
          </div>
          <div id="email-note" role="status" aria-live="polite">
            {emailError ? (
              <p className="error">{emailError}</p>
            ) : inUse ? (
              // 정말 막힌 경우: 빨간 한 줄 + 실행 버튼 비활성
              <p className="error">이미 사용 중인 계정입니다. 「비밀번호 재설정」을 안내해 주세요.</p>
            ) : blocked && pending ? (
              // 다시 보낼 수 없는 경우: 까닭은 아래 빨간 안내로, 실행 버튼은 「발급 취소」
              <p className="help">
                이미 만든 계정입니다({handle(pending.createdBy)} · {fmtMonthDay(pending.createdAt)}).
              </p>
            ) : pending ? (
              // 오류가 아니라 할 일이 바뀐 경우: 회색 안내 + 실행 버튼이 「안내 메일 다시 보내기」
              <p className="help">
                이미 만든 계정입니다({handle(pending.createdBy)} · {fmtMonthDay(pending.createdAt)}). 로그인 전이라 다시 보낼 수 있습니다.
              </p>
            ) : (
              <p className="help">주소가 틀리면 다른 사람이 계정을 받습니다.</p>
            )}
          </div>
        </div>

        <div className="field">
          <span id="language-label" className="t-body-200-b">
            메일 언어
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby="language-label">
            {LANGUAGES.map(({ value, label, Flag }) => (
              <button key={value} type="button" role="radio" aria-checked={language === value} onClick={() => setLanguage(value)}>
                <Flag />
                {label}
              </button>
            ))}
          </div>
        </div>

        {pending && !blocked && <p className="help">다시 보내면 이전 임시 비밀번호는 쓸 수 없게 됩니다.</p>}
        {blocked && <MailFailureMessage reason="blocked" />}
        {formError && (
          <p className="error mail-failure" role="alert">
            {formError}
          </p>
        )}

        {blocked && pending ? (
          // 목록 실패 창(K)과 같은 버튼: 「닫기」 · 「발급 취소」
          <div className="dialog-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>
              닫기
            </button>
            <button type="button" className="btn btn-danger-outline" onClick={() => onCancelIssue(pendingTarget(pending))}>
              발급 취소
            </button>
          </div>
        ) : (
          <div className="dialog-actions">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={sending}>
              취소
            </button>
            <button type="submit" className="btn btn-dark" disabled={inUse || sending} aria-busy={sending || undefined}>
              {sending ? "보내는 중…" : pending ? "안내 메일 다시 보내기" : "계정 만들고 메일 보내기"}
            </button>
          </div>
        )}
      </form>
    </Dialog>
  );
}

/**
 * 목록 줄의 「안내 메일 다시 보내기」 확인 창(F).
 * 메일 서버가 받지 않았으면 까닭을 보여 주고(J · K) 목록을 새로 고쳐 줄 상태를 바꿔요 — 이 창에서 다시 누르지 않아요.
 */
function ResendDialog({
  account,
  onClose,
  onResent,
  onMailFailed,
  onCancelIssue,
}: {
  account: Account;
  onClose: () => void;
  onResent: () => void;
  onMailFailed: () => void;
  onCancelIssue: (a: Account) => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [mailFailure, setMailFailure] = useState<MailFailureReason | "blocked" | null>(null);

  async function send() {
    setSending(true);
    setError("");
    const res = await resendGuide(account.id, account.language);
    setSending(false);
    if (res.ok) return onResent();
    if (isMailFailure(res.reason)) {
      setMailFailure(res.reason);
      return onMailFailed();
    }
    setError(resendErrorText(res.reason));
  }

  if (mailFailure) {
    return (
      <Dialog title="안내 메일 다시 보내기" onClose={onClose}>
        <MailFailureResult account={account} reason={mailFailure} onClose={onClose} onCancelIssue={onCancelIssue} />
      </Dialog>
    );
  }

  return (
    <Dialog title="안내 메일 다시 보내기" onClose={onClose} closable={!sending}>
      <div className="summary">
        <div className="summary-target">
          <strong>{account.company}</strong>
          <span>{account.email}</span>
        </div>
        <dl className="summary-rows">
          <div>
            <dt>메일 언어</dt>
            <dd>{languageName(account.language)}</dd>
          </div>
          <div>
            <dt>임시 비밀번호</dt>
            <dd>새로 발급 · 이전 비밀번호는 사용 불가</dd>
          </div>
        </dl>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={sending}>
          취소
        </button>
        <button type="button" className="btn btn-dark" onClick={send} disabled={sending} aria-busy={sending || undefined}>
          {sending ? "보내는 중…" : "다시 보내기"}
        </button>
      </div>
    </Dialog>
  );
}

/** 목록 줄의 「발급 취소」 확인 창(H · 휴대폰 M4). 누르는 사이 고객이 로그인했으면 취소하지 않아요(H2). */
function CancelDialog({
  account,
  onClose,
  onCancelled,
}: {
  account: Account;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<"" | "in_use" | "not_found" | "failed">("");

  async function cancel() {
    setSending(true);
    setError("");
    const res = await cancelIssue(account.id);
    setSending(false);
    if (res.ok) return onCancelled();
    setError(res.reason);
  }

  return (
    <Dialog title="발급 취소" onClose={onClose} closable={!sending}>
      <div className="summary">
        <div className="summary-target">
          <strong>{account.company}</strong>
          <span>{account.email} · 첫 로그인 전</span>
        </div>
        <dl className="summary-rows">
          <div>
            <dt>삭제 대상</dt>
            <dd>
              계정 · 데모 프로젝트{account.demoRecords !== undefined && `(데모 기록 ${account.demoRecords}건)`}
            </dd>
          </div>
          <div>
            <dt>보낸 메일</dt>
            <dd>비밀번호와 체험 링크를 쓸 수 없게 됨</dd>
          </div>
          <div>
            <dt>재발급</dt>
            <dd>같은 이메일로 가능</dd>
          </div>
        </dl>
      </div>
      {error && (
        <p className="error" role="alert">
          {error === "in_use"
            ? "고객이 이미 로그인해서 취소할 수 없습니다. 목록에서 「사용 중」으로 바뀝니다."
            : error === "not_found"
              ? "이미 발급 취소된 계정입니다. 목록에서 「발급 취소」로 바뀝니다."
              : "발급을 취소하지 못했습니다. 다시 시도해 주세요."}
        </p>
      )}
      <div className="dialog-actions">
        {error === "in_use" || error === "not_found" ? (
          <button type="button" className="btn btn-outline" onClick={onClose}>
            닫기
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={sending}>
              취소
            </button>
            <button type="button" className="btn btn-danger-outline" onClick={cancel} disabled={sending} aria-busy={sending || undefined}>
              {sending ? "취소하는 중…" : "발급 취소"}
            </button>
          </>
        )}
      </div>
    </Dialog>
  );
}
