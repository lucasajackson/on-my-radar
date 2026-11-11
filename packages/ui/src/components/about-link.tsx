/**
 * Back to the marketing site, with a full navigation: it is another origin
 * behind the same host, split by path at the edge.
 *
 * `/` is the marketing home only for a browser holding no session cookie, which
 * is the /login case. The waiting room has one (a pending account), so `/`
 * there is the app, which sends it straight back to the waiting room; it links
 * to `/features`, which is marketing whatever cookie is held.
 */
export function AboutLink({ href = '/' }: { href?: '/' | '/features' }) {
  return (
    <p className="mt-6 text-center text-[13px]">
      <a className="text-[color:var(--paper-dim)] underline-offset-4 hover:underline" href={href}>
        What is On My Radar?
      </a>
    </p>
  );
}
