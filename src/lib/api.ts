// 서버 연결 지점 (UG-405). 화면은 이 파일의 함수만 불러요.
// 로그인은 Gate 인증 서버(/api/v1/auth/...), 계정 발급은 백오피스 서버(/api/v1/mgmt/...)예요. 둘 다 게이트웨이를 거쳐요.
// 백오피스는 허용된 직원만 쓸 수 있어요(서버의 직원 허용 목록). 목록에 없으면 로그인 때 「권한 없음」으로 막혀요.
import { ApiError, authed, publicPost, revokeRefreshToken, send } from "./http";
import { clearSession, getTokens, saveTokens } from "./session";

export type MailLanguage = "en" | "ko";

// 백오피스 계정(영업 · 대표). 플랫폼 팀이 서버에서 직접 만들어 줘요(만드는 화면 없음).
// 직원 이름은 어디에도 두지 않아요(개인정보). 회사 이메일로만 구분하고, 안내 메일 담당자 칸({sales_email})에도 이메일이 들어가요.
// 전화는 메일 템플릿의 회사 대표번호로 고정.
export type Staff = {
  email: string;
};

/**
 * pending = 영업이 만들었고 고객이 아직 첫 로그인 전 / in_use = 고객이 직접 가입했거나 로그인한 적 있음
 * cancelled = 발급 취소. 계정 · 데모 프로젝트는 지웠고, 발급 기록(이 줄)만 남겨요.
 */
export type AccountStatus = "pending" | "in_use" | "cancelled";

/**
 * 안내 메일을 보내지 못한 까닭(서버가 메일 서버 응답으로 판정).
 * temporary = 메일 서버 쪽 일시 오류(잠시 뒤 다시 보내면 될 수 있음) / address = 받는 주소가 유효하지 않음 / unknown = 그 밖의 실패
 */
export type MailFailureReason = "temporary" | "address" | "unknown";

export type Account = {
  id: string;
  company: string;
  email: string;
  language: MailLanguage;
  status: AccountStatus;
  /** 만든 직원의 회사 이메일 */
  createdBy: string;
  createdAt: string;
  /**
   * 데모 프로젝트에 쌓인 데모 기록 수. 로그인 없이 체험 링크로 써 봤을 수 있어서 발급 취소 확인 창에 보여 줘요.
   * 체험 링크 기능이 생기기 전까지 서버가 주지 않아요(없으면 건수를 빼고 보여 줘요).
   */
  demoRecords?: number;
  /** 발급 취소한 직원의 회사 이메일 · 시각(cancelled일 때만). 시스템이 정리한 기록이면 cancelledBy 가 없어요. */
  cancelledBy?: string;
  cancelledAt?: string;
  /** 마지막 안내 메일 발송이 실패했어요 — 다시 보내기로 복구해요 */
  mailFailed?: boolean;
  /**
   * 마지막 발송이 실패한 까닭. 없으면 마지막 발송이 성공했거나 실패한 적이 없어요(예전 서버도 주지 않아요).
   * 상태(status)는 그대로 pending 이라 필터 · 요약 카드에서는 「첫 로그인 전」으로 세요 — 목록 줄의 표시만 바뀌어요.
   */
  mailFailureReason?: MailFailureReason;
  /** 같은 주소로 3번 연속 주소 오류 — 서버가 다시 보내기를 막았어요(발급 취소만 가능) */
  resendBlocked?: boolean;
};

export type AccountQuery = { keyword?: string; status?: AccountStatus | "all"; page?: number; size?: number };

/** 목록 한 페이지. total = 조건에 맞는 전체 건수 */
export type AccountPage = { items: Account[]; total: number };

/** 요약 카드. 검색어 · 상태 필터와 무관한 전체 기준(서버가 셈) */
export type AccountSummary = { total: number; pending: number; inUse: number; cancelled: number; thisMonth: number };

export type CreateAccountInput = {
  company: string;
  email: string;
  language: MailLanguage;
};

/**
 * 이메일 칸을 벗어날 때 하는 미리 조회. 보내기 전에 상태를 보여 주려고 써요.
 * 서버는 보내기 때도 같은 판정을 다시 해요(조회와 보내기 사이에 바뀔 수 있어서).
 * pending 이면 그 발급 기록 번호(id)로 다시 보내요.
 * resendBlocked = 같은 주소로 3번 연속 주소 오류라 서버가 다시 보내기를 막았어요(발급 취소만 가능 · 목록과 같은 규칙).
 * 예전 서버는 주지 않아요(없으면 false).
 * company = 그 발급 기록의 회사명(창에 기록 그대로 보여 주려고). 서버가 주지 않으면 이메일만 보여요.
 */
export type EmailCheck =
  | { status: "new" }
  | { status: "pending"; id: string; createdBy: string; createdAt: string; language: MailLanguage; resendBlocked: boolean; company?: string }
  | { status: "in_use" };

export type CreateAccountResult =
  | { ok: true; account: Account; mailSent: true }
  // 계정은 만들었지만 안내 메일은 못 보냈어요 — 까닭에 따라 목록에서 다시 보내거나 발급 취소해요
  | { ok: true; account: Account; mailSent: false; mailFailureReason: MailFailureReason }
  // duplicate = 첫 로그인 전 계정이 이미 있음(다시 보내기로 안내) / in_use = 쓰던 비밀번호가 막히므로 보내지 않음
  | { ok: false; reason: "duplicate" | "in_use" | "failed" };

// 만들기 · 다시 보내기 모두 하루 제한은 두지 않아요.
// in_use = 그사이 고객이 로그인함 / not_found = 그사이 발급 취소됨 / failed = 서버 · 네트워크 문제(다시 누르면 될 수 있음)
// temporary · address · unknown = 메일을 보내지 못한 까닭 / blocked = 주소 오류가 3번 이어져 서버가 다시 보내기를 막음
export type ResendFailure = "in_use" | "not_found" | "failed" | MailFailureReason | "blocked";
export type ResendResult = { ok: true; requestedAt: string } | { ok: false; reason: ResendFailure };

/**
 * 발급 취소. in_use = 누르는 사이 고객이 로그인해서 취소하지 않음(서버가 누를 때 다시 판정)
 * not_found = 다른 직원이 먼저 취소함
 */
export type CancelResult = { ok: true } | { ok: false; reason: "in_use" | "not_found" | "failed" };

/**
 * invalid = 이메일 · 비밀번호가 맞지 않음 / forbidden = 백오피스를 쓸 수 없는 계정 / failed = 서버 · 네트워크 문제
 * password = 임시 비밀번호라 먼저 바꿔야 함(바꾸는 화면은 Gate 콘솔에 있어요)
 */
export type LoginResult =
  | { ok: true; staff: Staff }
  | { ok: false; reason: "invalid" | "forbidden" | "failed" | "password" };

const MGMT = "/api/v1/mgmt";

/** 서버 · 네트워크 문제(다시 시도하면 될 수 있는 것)인지 */
const isTransient = (e: unknown) =>
  !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500;

export async function login(email: string, password: string): Promise<LoginResult> {
  let tokens: { accessToken: string; refreshToken: string; mustSetPassword?: boolean };
  try {
    tokens = await publicPost("/api/v1/auth/login", { email, password });
  } catch (e) {
    return { ok: false, reason: isTransient(e) ? "failed" : "invalid" };
  }
  if (tokens.mustSetPassword) {
    // 관리자가 준 임시 비밀번호처럼 변경이 강제된 계정 — 서버가 다른 API 를 막으므로 들어가지 않아요(auth UMS-52 · 53).
    revokeRefreshToken(tokens.refreshToken);
    return { ok: false, reason: "password" };
  }
  try {
    // 허용된 직원인지 서버에 물어요. 토큰은 확인된 뒤에만 남겨요.
    const me = await send<{ accountId: string; email: string }>("GET", `${MGMT}/me`, {}, tokens.accessToken);
    saveTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    return { ok: true, staff: { email: me.email } };
  } catch (e) {
    revokeRefreshToken(tokens.refreshToken);
    if (e instanceof ApiError && e.status === 403 && e.code === "AUTH-171") return { ok: false, reason: "password" };
    if (e instanceof ApiError && e.status === 403) return { ok: false, reason: "forbidden" };
    return { ok: false, reason: "failed" };
  }
}

/** 로그아웃: 이 탭의 로그인 상태를 지우고, 서버 세션(리프레시 토큰)도 끝내요. 서버 응답은 기다리지 않아요. */
export function logout() {
  const refreshToken = getTokens()?.refreshToken;
  clearSession();
  if (refreshToken) revokeRefreshToken(refreshToken);
}

type AccountDto = Omit<Account, "cancelledBy" | "cancelledAt" | "mailFailureReason"> & {
  cancelledBy: string | null;
  cancelledAt: string | null;
  mailFailureReason?: MailFailureReason | null;
};

const MAIL_FAILURE_REASONS: readonly string[] = ["temporary", "address", "unknown"] satisfies MailFailureReason[];
const isMailFailureReason = (r: unknown): r is MailFailureReason => typeof r === "string" && MAIL_FAILURE_REASONS.includes(r);

const toAccount = (a: AccountDto): Account => ({
  id: a.id,
  company: a.company,
  email: a.email,
  language: a.language,
  status: a.status,
  createdBy: a.createdBy,
  createdAt: a.createdAt,
  mailFailed: a.mailFailed,
  ...(isMailFailureReason(a.mailFailureReason) ? { mailFailureReason: a.mailFailureReason } : {}),
  ...(a.resendBlocked ? { resendBlocked: true } : {}),
  ...(a.cancelledBy ? { cancelledBy: a.cancelledBy } : {}),
  ...(a.cancelledAt ? { cancelledAt: a.cancelledAt } : {}),
});

/** 계정 발급 목록. 모든 직원이 만든 계정을 최신순으로, 한 페이지씩(page 는 1부터) 보여 줘요. */
export async function listAccounts(query: AccountQuery = {}): Promise<AccountPage> {
  const params = new URLSearchParams();
  if (query.keyword?.trim()) params.set("keyword", query.keyword.trim());
  params.set("status", query.status ?? "all");
  params.set("page", String(query.page ?? 1));
  params.set("size", String(query.size ?? 20));
  const data = await authed<{ content: AccountDto[]; totalElements: number }>("GET", `${MGMT}/accounts?${params}`);
  return { items: data.content.map(toAccount), total: data.totalElements };
}

export function getSummary(): Promise<AccountSummary> {
  return authed<AccountSummary>("GET", `${MGMT}/accounts/summary`);
}

export async function checkEmail(email: string): Promise<EmailCheck> {
  const data = await authed<{
    status: "new" | "pending" | "in_use";
    id?: string;
    createdBy?: string;
    createdAt?: string;
    language?: MailLanguage;
    resendBlocked?: boolean | null;
    company?: string | null;
  }>("GET", `${MGMT}/accounts/email-check?email=${encodeURIComponent(email)}`);
  if (data.status === "pending" && data.id && data.createdBy && data.createdAt && data.language) {
    return {
      status: "pending",
      id: data.id,
      createdBy: data.createdBy,
      createdAt: data.createdAt,
      language: data.language,
      resendBlocked: data.resendBlocked === true,
      ...(data.company ? { company: data.company } : {}),
    };
  }
  return data.status === "in_use" ? { status: "in_use" } : { status: "new" };
}

/** 계정 만들기 — 서버가 계정 · 데모 프로젝트를 만들고 안내 메일을 보내요. 만든 직원은 서버가 로그인 정보로 정해요. */
export async function createAccount(input: CreateAccountInput): Promise<CreateAccountResult> {
  try {
    const data = await authed<{
      ok: boolean;
      reason?: "duplicate" | "in_use" | "failed";
      account?: AccountDto;
      mailSent?: boolean;
      mailFailureReason?: MailFailureReason | null;
    }>("POST", `${MGMT}/accounts`, input);
    if (data.ok && data.account) {
      const account = toAccount(data.account);
      if (data.mailSent) return { ok: true, account, mailSent: true };
      // 예전 서버는 까닭을 주지 않아요 — 「메일 발송 실패」(unknown)로 보여 줘요.
      const mailFailureReason = isMailFailureReason(data.mailFailureReason) ? data.mailFailureReason : "unknown";
      return { ok: true, account, mailSent: false, mailFailureReason };
    }
    return { ok: false, reason: data.reason ?? "failed" };
  } catch {
    return { ok: false, reason: "failed" };
  }
}

/** 첫 로그인 전 계정에 안내 메일을 다시 보내요(새 임시 비밀번호). id = 발급 기록 번호 */
export async function resendGuide(id: string, language: MailLanguage): Promise<ResendResult> {
  try {
    const data = await authed<{ ok: boolean; requestedAt?: string; reason?: string | null }>(
      "POST",
      `${MGMT}/accounts/${encodeURIComponent(id)}/resend`,
      { language },
    );
    if (data.ok && data.requestedAt) return { ok: true, requestedAt: data.requestedAt };
    // 예전 서버는 까닭을 주지 않아요 — 전처럼 「다시 시도해 주세요」로 보여 줘요.
    if (data.reason === "blocked" || isMailFailureReason(data.reason)) return { ok: false, reason: data.reason };
    return { ok: false, reason: "failed" };
  } catch (e) {
    if (e instanceof ApiError && e.code === "MGMT-102") return { ok: false, reason: "in_use" };
    if (e instanceof ApiError && e.code === "MGMT-101") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "failed" };
  }
}

/**
 * 첫 로그인 전 계정의 발급 취소: 계정 · 데모 프로젝트를 지우고, 보낸 메일의 임시 비밀번호와 체험 링크를 막아요.
 * 취소 안내 메일은 보내지 않아요. 목록에는 「발급 취소」 줄로 남고(누가 · 언제), 같은 이메일로 다시 발급할 수 있어요.
 * 만들기 · 다시 보내기 · 발급 취소는 할 때마다 누가 · 언제 했는지 서버가 기록해 둬요(나중에 「관리/보안 이력」에서 보기).
 */
export async function cancelIssue(accountId: string): Promise<CancelResult> {
  try {
    await authed("DELETE", `${MGMT}/accounts/${encodeURIComponent(accountId)}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError && e.code === "MGMT-102") return { ok: false, reason: "in_use" };
    if (e instanceof ApiError && e.code === "MGMT-101") return { ok: false, reason: "not_found" };
    return { ok: false, reason: "failed" };
  }
}
