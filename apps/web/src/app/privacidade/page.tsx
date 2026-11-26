import { Legal } from '@/components/Legal';

export const metadata = { title: 'Política de Privacidade — Social Manager' };

export default function Privacidade() {
  const contact = process.env.CONTACT_EMAIL;
  return (
    <Legal title="Política de Privacidade">
      <p>O Social Manager é uma ferramenta de uso restrito para gerenciar contas de redes sociais e conteúdo. Esta página explica quais dados ele usa e para quê.</p>

      <h2>Dados que acessamos</h2>
      <ul>
        <li><strong>Identificação do canal do YouTube</strong> conectado por você: id, nome e endereço (@) do canal.</li>
        <li><strong>Identificação das Páginas do Facebook</strong> que você liberar: id, nome e nome de usuário da Página. Não acessamos seu perfil pessoal, amigos ou mensagens.</li>
        <li><strong>Identificação do perfil do TikTok</strong> conectado por você: identificador da conta e nome de exibição.</li>
        <li><strong>Tokens de acesso</strong> fornecidos pelo Google, pela Meta e pelo TikTok quando você autoriza a conexão, usados apenas para publicar vídeos no canal, na Página ou no perfil que você conectou.</li>
        <li>Os vídeos e textos que você mesmo envia ou gera no sistema.</li>
      </ul>

      <h2>Como usamos</h2>
      <p>Usamos esses dados <strong>somente</strong> para oferecer as funções que você vê no sistema: conectar o canal e publicar os vídeos que você escolher. Não vendemos, não compartilhamos com terceiros para publicidade e não usamos para treinar modelos de IA.</p>
      <p>As informações recebidas da Meta e do TikTok são usadas apenas para as mesmas finalidades e seguem os termos de cada plataforma (Meta e TikTok). O uso e a transferência de informações recebidas das APIs do Google seguem a <a href="https://developers.google.com/terms/api-services-user-data-policy">Política de Dados do Usuário dos Serviços de API do Google</a>, incluindo os requisitos de Uso Limitado.</p>

      <h2>Armazenamento e segurança</h2>
      <p>Os tokens são guardados <strong>criptografados</strong> (AES-256-GCM) no banco de dados e nunca são exibidos na interface. O acesso ao painel exige senha de administrador.</p>

      <h2 id="exclusao">Como revogar e apagar (exclusão de dados)</h2>
      <ul>
        <li>No sistema, use <em>Contas sociais → Desconectar</em>: os tokens são apagados do nosso banco e, no YouTube, o acesso também é revogado no Google.</li>
        <li>YouTube: remova o acesso a qualquer momento em <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</li>
        <li>Facebook: remova o app em <em>Configurações → Apps e sites</em> da sua conta do Facebook.</li>
        <li>TikTok: remova o app em <em>Configurações → Segurança e permissões → Apps e serviços</em>.</li>
        <li>Para pedir a exclusão dos dados do seu canal, entre em contato{contact ? <>: <a href={`mailto:${contact}`}>{contact}</a></> : ' com o administrador do sistema'}.</li>
      </ul>

      <h2>Serviços de terceiros</h2>
      <p>O sistema usa a Vercel (hospedagem), um banco de dados Postgres e, quando você ativa a geração de conteúdo por IA, o provedor de IA que você configurar. Os termos desses serviços se aplicam ao uso deles.</p>
    </Legal>
  );
}
