import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Social Manager 2.0', description: 'Gestão de grupos sociais e inteligência artificial' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
