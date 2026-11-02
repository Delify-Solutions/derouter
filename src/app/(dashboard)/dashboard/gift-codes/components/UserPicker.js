"use client";

import { useEffect, useRef, useState } from "react";
import PropTypes from "prop-types";

/**
 * Pick customer accounts by e-mail or name. Searches the admin user list as the
 * admin types and keeps the picked accounts as removable chips. `value` is the
 * array of picked `{ id, email }`.
 */
export default function UserPicker({ value, onChange, label = "Tài khoản nhận", hint = null, id = "gift-user-picker" }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef(null);

  useEffect(() => {
    clearTimeout(timer.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setError("");
      return undefined;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(q)}&pageSize=8`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Không tìm được tài khoản");
        setResults(Array.isArray(data.users) ? data.users : []);
        setError("");
      } catch (e) {
        setError(e.message || "Không tìm được tài khoản");
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query]);

  const picked = new Set(value.map((user) => user.id));
  const add = (user) => {
    if (picked.has(user.id)) return;
    onChange([...value, { id: user.id, email: user.email }]);
    setQuery("");
    setResults([]);
  };
  const remove = (userId) => onChange(value.filter((user) => user.id !== userId));

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</label>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tài khoản đã chọn">
          {value.map((user) => (
            <li key={user.id} className="flex min-w-0 max-w-full items-center gap-1 border border-border bg-surface-2 pl-2 text-xs text-text-main">
              <span className="truncate font-mono" title={user.email}>{user.email}</span>
              <button
                type="button"
                onClick={() => remove(user.id)}
                aria-label={`Bỏ ${user.email}`}
                className="flex size-7 shrink-0 items-center justify-center text-text-muted hover:text-text-main"
              >
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">close</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Gõ email hoặc tên (từ 2 ký tự)"
        autoComplete="off"
        className="h-9 w-full border border-border bg-surface px-3 text-sm text-text-main focus:border-text-main focus:outline-none"
      />
      {(searching || error || results.length > 0 || query.trim().length >= 2) && (
        <div className="border border-border bg-surface" role="listbox" aria-label="Kết quả tìm tài khoản">
          {searching ? (
            <p className="px-3 py-2 text-xs text-text-muted">Đang tìm…</p>
          ) : error ? (
            <p className="px-3 py-2 text-xs text-danger" role="alert">{error}</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-text-muted">Không có tài khoản nào khớp.</p>
          ) : (
            results.map((user) => (
              <button
                key={user.id}
                type="button"
                role="option"
                aria-selected={picked.has(user.id)}
                disabled={picked.has(user.id)}
                onClick={() => add(user)}
                className="flex w-full min-w-0 items-center justify-between gap-3 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface-2 disabled:opacity-50"
              >
                <span className="min-w-0 truncate font-mono text-xs text-text-main" title={user.email}>{user.email}</span>
                <span className="shrink-0 text-xs text-text-muted">
                  {picked.has(user.id) ? "Đã chọn" : user.displayName || user.groupName || ""}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

UserPicker.propTypes = {
  value: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, email: PropTypes.string })).isRequired,
  onChange: PropTypes.func.isRequired,
  label: PropTypes.string,
  hint: PropTypes.string,
  id: PropTypes.string,
};
