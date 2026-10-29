"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { fmtUsd } from "./salesData";

const DOCS_URL = "https://github.com/Delify-Solutions/derouter#readme";
const REPO_URL = "https://github.com/Delify-Solutions/derouter";
const LICENSE_URL = "https://github.com/Delify-Solutions/derouter/blob/main/LICENSE";

const COLUMNS = [
  {
    title: "Gói thuê bao",
    links: [
      { href: "#plans", label: "So sánh các gói" },
      { href: "#models", label: "Danh mục model" },
      { href: "#pricing", label: "Bảng giá chi tiết" },
      { href: "#faq", label: "Câu hỏi thường gặp" },
    ],
  },
  {
    title: "Tài khoản",
    links: [
      { href: "/register", label: "Tạo tài khoản" },
      { href: "/login", label: "Đăng nhập" },
      { href: "/register?next=/account/plans", label: "Mua gói" },
      { href: "/usage", label: "Tra cứu sử dụng" },
    ],
  },
  {
    title: "Tài liệu",
    links: [
      { href: DOCS_URL, label: "README", external: true },
      { href: REPO_URL, label: "Mã nguồn", external: true },
      { href: LICENSE_URL, label: "Giấy phép MIT", external: true },
    ],
  },
];

export default function Footer({ modelCount, plans = [] }) {
  return (
    <footer className="border-t border-border bg-bg">
      <div className="shell py-14">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="font-mono text-base font-semibold tracking-tight text-text-main">
              <span className="text-text-subtle" aria-hidden="true">{"//"}</span> derouter
            </p>
            <p className="mt-4 max-w-xs text-sm text-text-muted">
              Credit dùng chung cho mọi model trong nhóm của bạn, trừ theo giá token, dùng qua
              một endpoint tương thích OpenAI.
            </p>
            <p className="mt-3 font-mono text-[11px] text-text-subtle">
              {plans.map((plan) => `${plan.name} ${fmtUsd(plan.priceUsd)}/tháng`).join(" · ")}
            </p>
            <p className="mt-1 font-mono text-[11px] text-text-subtle">{modelCount} model trong danh mục</p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">{column.title}</p>
              <ul className="mt-4 flex flex-col gap-2.5">
                {column.links.map((link) => (
                  <li key={`${column.title}-${link.label}`}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-text-muted transition-colors duration-150 hover:text-text-main"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-sm text-text-muted transition-colors duration-150 hover:text-text-main"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-xs text-text-subtle">
            © {new Date().getFullYear()} derouter
          </p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-xs text-text-subtle transition-colors duration-150 hover:text-text-main"
          >
            <span className="material-symbols-outlined text-[14px]">code</span>
            Delify-Solutions/derouter
          </a>
        </div>
      </div>
    </footer>
  );
}

Footer.propTypes = {
  plans: PropTypes.array,
  modelCount: PropTypes.number.isRequired,
};
