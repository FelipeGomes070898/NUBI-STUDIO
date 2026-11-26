# Roadmap

## Feito
1. Base: login do administrador, workspace, clientes, contas, grupos e vínculos N:N.
2. AI Gateway: cadastro seguro de provedor, teste, catálogo, ativação, preço, modelo por tarefa (auto/manual), jobs e histórico (texto, imagem, narração).
3. Financeiro: carteira central, reserva/débito atômicos, extrato, limite global e orçamento por cliente.

4. Conexão do YouTube por login Google (OAuth/PKCE), com renovação de token e desconexão.
5. Conexão de Páginas do Facebook por login Meta (token da Página criptografado).
6. Conexão do TikTok por login, com renovação (refresh token girado) e desconexão com revogação.
7. Publicação multi-rede: upload direto, grupo/contas, agora ou agendada, intervalo mínimo por conta, agendador e andamento por rede.

## Próximo
4. **Vídeo via gateway**: adapter assíncrono para o gateway escolhido (submit → poll → download) + fila BullMQ.
5. **Estúdio**: upload de mídia, biblioteca, preview, FFmpeg, presets 9:16 e 16:9 (versões por formato de grupo).
6. **Publicação (resto)**: versões por formato de grupo (9:16 e 16:9), calendário e títulos/legendas por rede.
7. **Integrações sociais**: upload para o YouTube (resumable) Facebook Reels e tratamento de auditoria do TikTok/YouTube, com as permissões aprovadas.
8. Operação: agendamento e publicação automática, notificações, analytics, relatórios, auditoria, RBAC e múltiplos usuários.
9. Monitoramento semanal de mudanças em APIs/modelos dos provedores.
