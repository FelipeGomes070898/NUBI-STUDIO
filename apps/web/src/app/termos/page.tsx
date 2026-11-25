import { Legal } from '@/components/Legal';

export const metadata = { title: 'Termos de Uso — Social Manager' };

export default function Termos() {
  return (
    <Legal title="Termos de Uso">
      <p>Ao usar o Social Manager você concorda com estes termos.</p>
      <h2>Uso permitido</h2>
      <p>A ferramenta deve ser usada apenas com contas e canais que você administra ou para os quais tem autorização do titular, e em conformidade com os termos de cada rede social (YouTube, Facebook, TikTok) e com a lei.</p>
      <h2>Conteúdo</h2>
      <p>Você é responsável pelo conteúdo que publica ou gera, inclusive o gerado por IA, e pelos custos cobrados pelos provedores de IA que configurar.</p>
      <h2>Conexão com contas</h2>
      <p>Você pode desconectar uma conta a qualquer momento. A disponibilidade da publicação depende das regras, cotas e aprovações de cada plataforma, que podem mudar.</p>
      <h2>Sem garantias</h2>
      <p>O serviço é fornecido “como está”, sem garantia de disponibilidade contínua. O responsável pelo sistema não responde por indisponibilidades ou bloqueios impostos pelas plataformas.</p>
    </Legal>
  );
}
