"use client";

import { Badge, Button, Input } from "@/shared/components";

/** Reusable endpoint row component */
export default function EndpointRow({ label, url, copyId, copied, onCopy, badge, actions }) {
  return (
    <div className="flex items-center gap-2">
      <Badge
        variant={(badge === "CF" || badge === "TS") ? "primary" : "default"}
        size="sm"
        className="min-w-[88px] shrink-0 justify-center font-mono"
      >
        {label}
      </Badge>
      <Input value={url} readOnly className="flex-1 font-mono text-sm" />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="size-7 shrink-0 px-0"
        onClick={() => onCopy(url, copyId)}
        aria-label={`Sao chép ${label}`}
        icon={copied === copyId ? "check" : "content_copy"}
      />
      {actions}
    </div>
  );
}
