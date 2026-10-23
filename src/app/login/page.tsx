"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Brand } from "@/components/ui";
import { IcVisibilityOff, IcVisibilityOn } from "@/components/icons";
import { login } from "@/lib/api";
import { saveStaff, useLoginReason, useStaff } from "@/lib/session";

/** 임시 비밀번호(변경 강제) 계정 — 비밀번호 바꾸는 화면은 Gate 콘솔에만 있어요. */
const PASSWORD_REQUIRED = "비밀번호를 바꿔야 백오피스를 쓸 수 있습니다. Gate 콘솔에 로그인해 비밀번호를 바꾼 뒤 다시 로그인해 주세요.";

export default function LoginPage() {
  const router = useRouter();
  const staff = useStaff();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 세션이 끊겨 이 화면으로 왔으면 이유를 보여 줘요(로그인을 다시 누르면 숨겨요).
  const reason = useLoginReason();
  const [noticeHidden, setNoticeHidden] = useState(false);
  const notice =
    noticeHidden || !reason
      ? ""
      : reason === "forbidden"
        ? "백오피스를 사용할 수 있는 계정이 아닙니다. 운영 담당자에게 요청해 주세요."
        : reason === "password"
          ? PASSWORD_REQUIRED
          : "로그인이 만료되었습니다. 다시 로그인해 주세요.";

  // 이미 로그인했으면 이 화면을 건너뛰어요.
  useEffect(() => {
    if (staff) router.replace("/accounts");
  }, [staff, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) {
      setError("이메일과 비밀번호를 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError("");
    setNoticeHidden(true);
    const res = await login(email.trim(), password);
    if (res.ok) {
      saveStaff(res.staff);
      router.replace("/accounts");
      return;
    }
    // 계정이 있는지 알려 주지 않도록 이메일 · 비밀번호 오류는 한 가지 문구만 써요.
    setError(
      res.reason === "forbidden"
        ? "백오피스를 사용할 수 있는 계정이 아닙니다. 운영 담당자에게 요청해 주세요."
        : res.reason === "password"
          ? PASSWORD_REQUIRED
          : res.reason === "failed"
          ? "로그인하지 못했습니다. 잠시 후 다시 시도해 주세요."
          : "이메일 또는 비밀번호가 맞지 않습니다.",
    );
    setBusy(false);
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={onSubmit} noValidate>
        <div className="login-brand">
          <Brand inverse />
        </div>
        {/* 제목은 화면에서 빼고(버튼과 같은 말) 화면 읽기 프로그램용으로만 남겨요 */}
        <h1 className="visually-hidden">로그인</h1>
        {notice && (
          <p className="error" role="status">
            {notice}
          </p>
        )}

        <div className="field">
          <label htmlFor="email" className="t-body-200-b">
            이메일
          </label>
          <div className="input-box">
            <input
              id="email"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="password" className="t-body-200-b">
            비밀번호
          </label>
          <div className={`input-box${error ? " is-error" : ""}`}>
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "login-error" : undefined}
            />
            <button
              type="button"
              className="eye-toggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "비밀번호 숨기기" : "비밀번호 보기"}
              aria-pressed={showPassword}
            >
              {showPassword ? <IcVisibilityOn size={18} /> : <IcVisibilityOff size={18} />}
            </button>
          </div>
          {error && (
            <p id="login-error" className="error" role="alert">
              {error}
            </p>
          )}
        </div>

        <button type="submit" className="btn btn-dark" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "로그인 중…" : "로그인"}
        </button>

        <p className="help">계정이 없으면 운영 담당자에게 요청해 주세요.</p>
      </form>
      <p className="login-copyright">ⓒ 2026 UNIVERSE AI</p>
    </main>
  );
}
