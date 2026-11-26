import { NavLink } from '@/components/NavLink';
import { logout } from '../login/actions';

const NAV: Array<[string, string, string]> = [
  ['/', '▦', 'Dashboard'],
  ['/clients', '☰', 'Clientes'],
  ['/groups', '▧', 'Grupos de contas'],
  ['/accounts', '◎', 'Contas sociais'],
  ['/ai', '✧', 'Central de IA'],
  ['/ai/studio', '✎', 'Estúdio de IA'],
  ['/publications', '➤', 'Publicações'],
  ['/billing', '$', 'Custos e consumo'],
];
const SOON = ['Estúdio de vídeos', 'Biblioteca de mídia', 'Calendário', 'Analytics'];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="layout">
      <aside>
        <div className="logo">◈ Social Manager <small>2.0</small></div>
        <p className="muted">MENU PRINCIPAL</p>
        <nav>
          {NAV.map(([href, icon, label]) => (
            <NavLink key={href} href={href} icon={icon}>{label}</NavLink>
          ))}
        </nav>
        <p className="muted soonTitle">EM BREVE</p>
        {SOON.map((s) => (
          <div className="nav disabled" key={s}>{s}</div>
        ))}
        <form action={logout} className="profile">
          <button className="linkBtn">Sair</button>
        </form>
      </aside>
      <section className="main">{children}</section>
    </div>
  );
}
