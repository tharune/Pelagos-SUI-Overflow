import { redirect } from "next/navigation";

/**
 * `/app` no longer has a Markets landing of its own — the old
 * curated-markets grid has been retired and the nav now sends users
 * straight to their portfolio. Anyone still hitting `/app` from a
 * bookmark or external link gets forwarded to `/app/portfolio`.
 */
export default function AppRoot() {
  redirect("/app/portfolio");
}
