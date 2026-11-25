'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLink({ href, icon, children }: { href: string; icon: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = href === '/' ? path === '/' : path === href || path.startsWith(href + '/');
  return (
    <Link href={href} className={`nav ${active ? 'selected' : ''}`} aria-current={active ? 'page' : undefined}>
      <span className="navIcon">{icon}</span> {children}
    </Link>
  );
}
