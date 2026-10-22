import type { Metadata } from "next";

// 화면에는 「로그인」 제목이 없어서, 브라우저 탭 제목으로 어떤 페이지인지 알려요.
export const metadata: Metadata = { title: "로그인 · UNIVS GATE Backoffice" };

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
