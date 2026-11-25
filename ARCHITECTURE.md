# Arquitetura Social Manager 2.0

## Estrutura
```
apps/web            Next.js (UI em server components + server actions)
  src/server        domínio: ai/ (adapters, roteamento, preços, jobs), billing/, directory, crypto
  src/lib           sessão, helpers de formulário/ação
packages/db         schema Prisma, migrations, seed, singleton do client
```
Regras de negócio puras (roteamento, estimativa de custo, orçamento, expansão de grupos) não tocam banco nem rede e têm testes unitários; o que mexe em dinheiro tem testes contra Postgres real.

## Hierarquia
Workspace → Clients / AccountGroups / SocialAccounts / Providers / Wallet.
`AccountGroup ⟷ SocialAccount` via `GroupMembership` (N:N). O grupo é uma coleção de distribuição, não um cliente; `clientId` no grupo e na conta é opcional.
Hoje o app roda em **workspace único** (`ws_default`); o schema e todas as consultas já filtram por `workspaceId`.

## Publicação (modelo pronto, fluxo ainda não construído)
`Publication` = conteúdo base; `PublicationTarget` = destino (conta + variante). `resolveTargets()` expande grupos em destinos: remove contas desmarcadas, ignora inativas e **deduplica** conta presente em mais de um grupo. Formato do grupo é preferência/validação, não garantia de compatibilidade da plataforma.

## AI Gateway
- `AIProvider` guarda URL e chave **criptografada**; `AIModel` é o catálogo importado; `AITaskPreference` define modo/modelo por tarefa; `AIJob` registra cada geração.
- Adapter único hoje: `OPENAI_COMPATIBLE` (`/models`, `/chat/completions`, `/images/generations`, `/audio/speech`). **Vídeo não é padronizado entre gateways** e exige adapter próprio; o roteamento já recusa vídeo com mensagem clara enquanto não houver.
- Sincronizar o catálogo cria modelos **desativados**: o roteamento automático só usa o que você habilitou. Modalidades detectadas pelo id são sugestão editável; a re-sincronização não sobrescreve edições nem preço informado manualmente.
- Roteamento (`planRoute`, puro):
  1. Modelo escolhido na geração → só ele, sem fallback.
  2. Tarefa em modo MANUAL → modelo fixo + alternativas **aprovadas**.
  3. AUTO → modelos preferidos/aprovados da tarefa; sem eles, todos os compatíveis ordenados por provedor principal → menor custo estimado (sem preço por último).
  4. Fallback acontece no planejamento (modelo indisponível ou fora do orçamento). Falha **durante** a chamada não troca de modelo: o job falha com o motivo e você decide (evita cobrança dupla).
- Retentativa só em 429/503 (rejeitados antes de processar). Timeout/erro de rede **não** repete.
- Chamadas são síncronas dentro da requisição (texto/imagem/áudio). Fila (BullMQ) e vídeo assíncrono são a próxima etapa; `executeAIJob` já é idempotente (claim `QUEUED→RUNNING`) para ser chamado por um worker.

## Financeiro
- **Carteira = controle interno.** O saldo real e a cobrança ficam no provedor; registre créditos manualmente.
- Fluxo de uma geração, serializado por `SELECT … FOR UPDATE` na carteira: estima o **custo máximo** (entrada estimada + teto de saída enviado ao modelo) → verifica saldo livre, limite mensal global e orçamento do cliente → **reserva** → chama o provedor → libera a reserva e **debita o custo real** (informado pelo provedor, ou uso real × preço cadastrado).
- Modelo **sem preço** é bloqueado por padrão (custo não controlável); dá para permitir em Custos. Nesse caso só há débito se o provedor informar o custo.
- Job que fica preso (processo caiu) tem a reserva liberada após 15 min e é marcado como falho; confira no painel do provedor se houve cobrança.
- Estimativa não é cobrança final. Tudo em USD; o mês dos limites é UTC.

## Segurança
- Sessão por cookie HMAC (`AUTH_SECRET`), `HttpOnly`, `SameSite=Lax`; middleware barra tudo e cada server action revalida. Sem `ADMIN_PASSWORD`/`AUTH_SECRET` válidos, o login fica bloqueado (falha fechada). Limite de tentativas de login em memória (1 instância).
- Chaves: AES-256-GCM com `ENCRYPTION_KEY`; só os 4 últimos caracteres aparecem na UI; mensagens de erro do provedor são truncadas e a chave só trafega no header `Authorization`; redirects do provedor são recusados.
- URL do gateway: https obrigatório (http só em localhost), sem credenciais embutidas. O servidor faz requisições a essa URL, então só o administrador deve ter acesso ao painel.
- Saídas geradas são servidas só para sessão válida e apenas com tipos seguros (png/jpeg/webp/mp3/wav).
- Pendente: RBAC (owner/admin/editor/approver/viewer), auditoria, KMS em produção, rate limit distribuído.

## Workers (próxima etapa)
BullMQ para geração assíncrona, renderização, agendamento, publicação e métricas. Jobs idempotentes; retry exponencial só para erro transitório.
