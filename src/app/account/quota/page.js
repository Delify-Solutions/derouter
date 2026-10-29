import { permanentRedirect } from "next/navigation";

// The per-model allowance page is gone: a purchase is one shared credit pool with
// per-window limits, and /account/plans shows it in full. The URL is kept as a
// permanent redirect so old links and bookmarks still land somewhere useful.
export default function AccountQuotaPage() {
  permanentRedirect("/account/plans");
}
