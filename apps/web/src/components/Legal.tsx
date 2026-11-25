import Link from 'next/link';

export function Legal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="legal">
      <p><Link href="/login">← Social Manager</Link></p>
      <h1>{title}</h1>
      <p className="dim">Última atualização: 25/11/2026. Modelo básico; não substitui orientação jurídica.</p>
      {children}
    </main>
  );
}
