"use client";

import { useState } from "react";

/**
 * Thumbnail of a generated test image that links to the full image. When the browser
 * cannot show it (an http:// URL blocked by the CSP, an expired signed URL) it falls
 * back to a plain "Open image" link instead of a broken-image icon.
 */
export default function PreviewThumb({ src, alt = "Generated test", className = "" }) {
  const [failed, setFailed] = useState(false);
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="shrink-0 block">
      {failed ? (
        <span className="inline-flex items-center gap-1 text-xs text-primary underline">
          <span className="material-symbols-outlined text-[14px]">open_in_new</span>
          Open image
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />
      )}
    </a>
  );
}
