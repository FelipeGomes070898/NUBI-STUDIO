# Social Manager 2.0

Plataforma web para gerenciar **grupos de contas sociais** e um **estúdio de IA** com gateway unificado, escolha de modelo (automática ou manual) e **carteira central com orçamento por cliente**.

## Decisões de produto
- Grupos de publicação independentes de clientes; uma conta pode estar em vários grupos.
- Cada grupo tem formato padrão (9:16, 16:9, 1:1 ou flexível). O grupo **sugere** destinos; você pode desmarcar contas antes de programar.
- AI Gateway: provedor unificado como integração principal; provedores individuais podem ser adicionados.
- Seleção de modelo **automática ou manual**, por tarefa.
- Carteira central com limite mensal global e orçamento mensal por cliente.

## O que já funciona (esta fase)
| Módulo | Estado |
|---|---|
| Login do administrador (cookie assinado, falha fechada) | ✅ |
| Clientes (orçamento mensal de IA) | ✅ |
| Contas sociais (cadastro manual) | ✅ |
| Grupos: formato, contas por grupo, conta em vários grupos | ✅ |
| Central de IA: cadastro de gateway (chave criptografada), teste de conexão, sincronização de catálogo, ativação de modelos, preço por modelo, modelo por tarefa (auto/manual + alternativas aprovadas) | ✅ |
| Estúdio de IA: texto, imagem e narração via API no formato OpenAI; histórico | ✅ |
| Carteira: saldo, reserva antes da chamada, débito do custo real, extrato, limites | ✅ |
| Conexão **YouTube** por login Google (OAuth + PKCE), tokens criptografados e renovação automática; páginas públicas de Privacidade e Termos | ✅ (precisa das chaves `GOOGLE_*`) |
| Conexão **Facebook** (Páginas) por login Meta: uma conta por Página liberada, token da Página criptografado | ✅ (precisa das chaves `META_*`) |
| Geração de **vídeo** | ⏳ precisa de adapter para o seu gateway (ver `docs/INTEGRATION_CONTRACT.md`) |
| Upload de vídeo para o YouTube, OAuth do TikTok, agendamento, calendário, analytics, FFmpeg | ⏳ próximas etapas (ver `ROADMAP.md`) |

> Os adapters foram testados contra um **servidor simulado** no padrão OpenAI, não contra um gateway real. Antes de confiar em produção, rode o fluxo com a sua chave real (e um saldo pequeno).

## Stack
Next.js 15 (App Router, server actions) · TypeScript · PostgreSQL + Prisma · pnpm workspaces. Redis/BullMQ, FFmpeg e S3 entram nas etapas de fila, vídeo e mídia.

## Rodando localmente
Requisitos: Node.js 20+, pnpm 10 e Docker (para Postgres/Redis).

```bash
cp .env.example apps/web/.env.local
```

Preencha em `apps/web/.env.local`:
- `ADMIN_PASSWORD` — senha do painel
- `AUTH_SECRET` — `openssl rand -base64 32`
- `ENCRYPTION_KEY` — `openssl rand -base64 32` (**guarde**: sem ela as chaves de API cadastradas ficam ilegíveis)
- `DATABASE_URL` — já aponta para o `docker-compose.yml`

```bash
docker compose up -d
pnpm install
export DATABASE_URL=postgresql://socialmanager:socialmanager@localhost:5432/socialmanager
pnpm db:migrate        # cria as tabelas
pnpm db:seed           # (opcional) grupos de exemplo: Luciano ZEEN, Canal Espacial, Facebook independente
pnpm dev               # http://localhost:3000
```

Depois: **Central de IA** → adicionar provedor (URL base + chave) → *Testar conexão* → *Sincronizar modelos* → ativar os modelos que quiser e **informar o preço** de cada um → **Custos** → registrar crédito → **Estúdio de IA**.

## Testes
```bash
pnpm test                                   # unitários (não precisam de banco)
TEST_DATABASE_URL=postgresql://socialmanager:socialmanager@localhost:5432/socialmanager_test pnpm test
```
Com `TEST_DATABASE_URL` (banco já migrado com `prisma migrate deploy`), rodam também os testes de integração com Postgres real e um gateway falso local. **Esse banco é truncado a cada teste: use um banco só para testes.**

## Segurança
Chaves de API e tokens ficam criptografados (AES-256-GCM) e nunca são enviados ao navegador nem logados. Nunca coloque chaves reais no Git. Detalhes e limites conhecidos em `ARCHITECTURE.md`.

## Conectar o YouTube
1. Google Cloud → projeto → ativar **YouTube Data API v3** → tela de consentimento (Externo; escopos `youtube.upload` e `youtube.readonly`; links de Privacidade/Termos: `<seu-domínio>/privacidade` e `/termos`) → **ID do cliente OAuth** (Aplicativo da Web) com o redirecionamento `<seu-domínio>/api/oauth/youtube/callback`.
2. Variáveis (Sensitive): `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. Opcional: `APP_URL` (domínio canônico; na Vercel usa o domínio de produção) e `CONTACT_EMAIL` (aparece na Política de Privacidade).
3. Novo deploy → *Contas sociais* → **Conectar com YouTube**.

Com a tela de consentimento em modo "Teste", o acesso expira em 7 dias: publique o app. Uploads por API podem ficar privados até a auditoria do Google, e a cota diária é do projeto, não do canal.

## Conectar o Facebook (Páginas)
1. [developers.facebook.com](https://developers.facebook.com) → criar app (tipo Business) com o caso de uso de gerenciar Páginas / Facebook Login. Em *Facebook Login → Configurações*, em **URIs de redirecionamento OAuth válidos**: `<seu-domínio>/api/oauth/facebook/callback`.
2. Em *Configurações → Básico*: domínio do app, **Política de Privacidade** `<seu-domínio>/privacidade`, **Termos** `<seu-domínio>/termos` e, para exclusão de dados, a URL de instruções `<seu-domínio>/privacidade#exclusao`.
3. Variáveis (Sensitive): `META_APP_ID` e `META_APP_SECRET`. Opcionais: `META_GRAPH_VERSION` (padrão `v23.0`) e `META_SCOPES` (ex.: incluir `business_management` se as Páginas ficam em Portfólio Empresarial).
4. Novo deploy → *Contas sociais* → **Conectar com Facebook** → na tela da Meta, escolha as Páginas.

Com o app em modo **Desenvolvimento**, só quem tem função no app (administrador, desenvolvedor ou testador) consegue conectar, e só Páginas que essa pessoa administra. Para Páginas de terceiros sem dar função a eles, o app precisa ir para o modo **Ativo** com Acesso Avançado (revisão do app e, em geral, verificação da empresa). O token da Página não tem refresh: se a Meta o recusar (código 190), a conta vira "token expirado" e pede reconexão.
