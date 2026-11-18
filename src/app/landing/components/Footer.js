"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { fmtUsd } from "./salesData";

const COLUMNS = [
  {
    title: "Gói",
    links: [
      { href: "/#plans", label: "Các gói" },
      { href: "/models", label: "Model" },
      { href: "/#pricing", label: "Bảng giá" },
      { href: "/#faq", label: "Câu hỏi thường gặp" },
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
      { href: "/docs", label: "Hướng dẫn sử dụng" },
    ],
  },
];

export default function Footer({ modelCount, plans = [], channelUrl = "" }) {
  return (
    <footer className="border-t border-border bg-bg">
      <div className="shell py-14">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="font-mono text-base font-semibold tracking-tight text-text-main">
              <span className="text-text-subtle" aria-hidden="true">{"//"}</span> derouter
            </p>
            <p className="mt-4 max-w-xs text-sm text-text-muted">
              Một khoản credit dùng chung cho mọi model, trừ theo giá token. Một endpoint cho cả client OpenAI và Claude.
            </p>
            <p className="mt-3 font-mono text-[11px] text-text-subtle">
              {plans.map((plan) => `${plan.name} ${fmtUsd(plan.priceUsd)} / ${plan.durationDays} ngày`).join(" · ")}
            </p>
            <p className="mt-1 font-mono text-[11px] text-text-subtle">{modelCount} model trong danh mục</p>
          </div>

          {(channelUrl
            ? COLUMNS.map((column, index) => (index === COLUMNS.length - 1
              ? { ...column, links: [...column.links, { href: channelUrl, label: "Kênh Telegram", external: true }] }
              : column))
            : COLUMNS).map((column) => (
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
        </div>
      </div>
    </footer>
  );
}

Footer.propTypes = {
  plans: PropTypes.array,
  modelCount: PropTypes.number.isRequired,
  channelUrl: PropTypes.string,
};
