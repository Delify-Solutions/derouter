import { permanentRedirect } from "next/navigation";

// `/landing` was the public entry before `/` took that role. Keep it as a
// permanent redirect so existing links and bookmarks land on the canonical URL.
export default function LandingRedirectPage() {
  permanentRedirect("/");
}
