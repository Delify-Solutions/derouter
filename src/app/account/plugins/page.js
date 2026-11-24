import PluginsPageClient from "./PluginsPageClient";

export const metadata = {
  title: "Plugin DSH - derouter",
};

export const dynamic = "force-dynamic";

export default function AccountPluginsPage() {
  return <PluginsPageClient />;
}
