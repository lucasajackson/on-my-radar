/**
 * The admin dashboard: the frame every admin section sits in.
 *
 * One gate for the whole area, here rather than per section, so a section added
 * later cannot forget it. The server refuses every `/api/admin/*` call to a
 * non-admin regardless — this only decides what is painted.
 *
 * Sub-routes rather than one long page: each section answers its own question
 * (how is the instance doing, who is waiting, what can profiles offer), and a
 * URL per section is what makes "go and approve Sam" a link.
 */
import { useLayoutEffect, useRef } from 'react';
import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { useSession } from '../lib/session';
import { Empty } from '../components/primitives';

const SECTIONS = [
  { to: '/admin', label: 'Overview', exact: true },
  { to: '/admin/people', label: 'People', exact: false },
  { to: '/admin/agents', label: 'Agents', exact: false },
  { to: '/admin/models', label: 'Model catalog', exact: false },
] as const;

export function AdminRoute() {
  const { user } = useSession();
  const pathname = useLocation({ select: (location) => location.pathname });
  const sections = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = sections.current;
    const active = nav?.querySelector('[aria-current="page"]');
    if (!nav || !active) return;
    const strip = nav.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    // Reveal the selected section without moving the page's vertical position.
    if (tab.left < strip.left) nav.scrollLeft += tab.left - strip.left;
    else if (tab.right > strip.right) nav.scrollLeft += tab.right - strip.right;
  }, [pathname, user?.isAdmin]);
  if (!user?.isAdmin) {
    return <Empty title="Admins only" hint="This screen is for account administrators." />;
  }
  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5 px-4 py-6 sm:px-6">
      <header>
        <h1 className="text-[21px] font-semibold tracking-tight">Admin</h1>
        <p className="instrument mt-1">This instance, its people, and what agents may run on.</p>
      </header>

      <nav ref={sections} className="scroll-area section-tabs" aria-label="Admin sections">
        {SECTIONS.map(({ to, label, exact }) => (
          <Link
            key={to}
            to={to}
            className="section-tab"
            activeOptions={{ exact }}
            activeProps={{ className: 'is-active', 'aria-current': 'page' }}
          >
            {label}
          </Link>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
