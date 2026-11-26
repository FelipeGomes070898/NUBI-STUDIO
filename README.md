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
| Conexão **TikTok** por login (OAuth), tokens criptografados e renovação automática | ✅ (precisa das chaves `TIKTOK_*`) |
| **Publicações**: envio do vídeo uma vez e publicação em YouTube, Facebook e TikTok de uma vez (grupo ou contas escolhidas), agora ou agendada, com intervalo mínimo por conta e registro do último post/agendamento | ✅ (precisa do Vercel Blob e do agendador; ver abaixo) |
| **Instagram** (conta Profissional ligada à Página): conexão pelo login do Facebook; publicação de Reels e Stories | ✅ (usa as chaves `META_*`; precisa das permissões do Instagram no app da Meta) |
| **Stories** do Facebook e do Instagram, e **Metas da semana** (1 post / 1 story por conta, domingo a domingo, editáveis) | ✅ |
| **Estúdio de vídeos**: ideia → roteiro em cenas → vídeo (Google Veo) com **personagem fixo por grupo** → montagem na duração exata (FFmpeg) → thumbnail (ChatGPT), título, descrição, tags e hashtags (Claude) → publicar | ✅ (precisa de provedor Google/Veo com preço, Blob e agendador) |
| **Personagens**: descrição fixa + imagens de referência, fixados por grupo | ✅ |
| Anúncios, resposta automática a mensagens/comentários, insights, calendário | ⏳ / fora do escopo (ver abaixo e `ROADMAP.md`) |

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

## Conectar o TikTok
1. [developers.tiktok.com](https://developers.tiktok.com) → *Manage apps* → criar app → adicionar os produtos **Login Kit** e **Content Posting API** (habilite *Direct Post* se quiser publicar direto).
2. No Login Kit, registre o **Redirect URI**: `<seu-domínio>/api/oauth/tiktok/callback`. Preencha as URLs de Termos (`<seu-domínio>/termos`) e Privacidade (`<seu-domínio>/privacidade`).
3. O TikTok exige **verificar a propriedade das URLs** (*URL properties*). Para um domínio `*.vercel.app` use *URL prefix*: baixe o arquivo `tiktokXXXX.txt` que o portal fornece e coloque em `apps/web/public/` (o middleware já deixa `tiktok*.txt` abrir sem login).
4. Variáveis (Sensitive): `TIKTOK_CLIENT_KEY` e `TIKTOK_CLIENT_SECRET`. Opcional: `TIKTOK_SCOPES` (padrão `user.info.basic,video.upload,video.publish`; se o portal recusar um escopo por o produto ainda não estar liberado, remova-o).
5. Novo deploy → *Contas sociais* → **Conectar com TikTok**.

Enquanto o app não passar na auditoria do TikTok, as postagens diretas ficam restritas (privadas) e só contas de teste (*Sandbox*) conseguem autorizar. Contas conectadas sem permissão de vídeo aparecem marcadas "sem permissão de publicar vídeo". O refresh token do TikTok pode girar a cada renovação; o sistema sempre salva o novo.

## Publicar vídeos
**Nova publicação** → enviar o vídeo (vai do navegador direto ao Vercel Blob; não passa pelo limite de 4,5 MB da função) → marcar grupos (e desmarcar contas) → título/legenda/visibilidade → *Publicar agora* ou *Agendar*.

Configuração (uma vez):
1. **Vercel Blob**: no projeto, *Storage → Create → Blob* e conectar ao projeto (cria `BLOB_READ_WRITE_TOKEN`). Os vídeos ficam em endereço público **não listado** (com sufixo aleatório): quem tiver o link consegue ver, e o Facebook precisa disso para buscar o arquivo.
2. **Agendador**: defina `CRON_SECRET` (≥16 caracteres, `openssl rand -base64 32`) na Vercel e, no GitHub, em *Settings → Secrets and variables → Actions*, os secrets `APP_URL` (ex.: `https://nubi-studio.vercel.app`) e `CRON_SECRET` (o mesmo valor). O workflow `.github/workflows/publish-scheduler.yml` chama `/api/cron/publish` a cada ~5 min. O GitHub pode atrasar execuções agendadas em alguns minutos; o horário é "a partir de", não exato. A Vercel (plano Hobby) também chama 1×/dia. Alternativa mais pontual: um serviço de cron externo (ex.: cron-job.org) fazendo `POST` nesse endereço com o header `Authorization: Bearer <CRON_SECRET>`.
3. Opcionais: `MAX_VIDEO_MB` (512), `PUBLISH_MIN_GAP_MINUTES` (60), `APP_TIMEZONE` (America/Sao_Paulo).

Regras:
- **Intervalo mínimo por conta** (60 min): não deixa agendar uma conta a menos de 60 min de outra publicação dela (agendada, em andamento ou já publicada). A mensagem diz qual conta e qual horário bloqueia; há a opção de ignorar. O último post e o último agendamento de cada conta aparecem no formulário.
- Horários são digitados no fuso do navegador e guardados em UTC.
- Cada rede tem o seu andamento: uma falha não impede as outras. **Falhas não são repetidas sozinhas** (evita post duplicado); use *Tentar de novo* depois de conferir na rede. Destino "publicando" por mais de 20 min vira falha.
- YouTube: envio retomável; projetos de API sem auditoria do Google costumam ficar privados (o sistema avisa). Facebook: a Meta busca o vídeo pela URL. TikTok: envio em partes; app sem auditoria só publica como privado, e conta só com `video.upload` recebe o vídeo como rascunho no app.

## Instagram
O Instagram é conectado **pelo Facebook**: só funciona com conta **Profissional** (Comercial ou Criador) ligada a uma Página.
1. No app da Meta, adicione o caso de uso de publicação no Instagram ("Gerenciar mensagens e conteúdo no Instagram", nomes mudam) e habilite `instagram_basic` e `instagram_content_publish` (em modo Desenvolvimento não precisa de revisão para contas suas).
2. *Contas sociais* → **Conectar Instagram** (o botão do Facebook continua pedindo só as permissões de Página, para não quebrar quem ainda não habilitou o Instagram). Cada Página escolhida que tenha Instagram ligado vira uma conta `INSTAGRAM`.
3. Post de vídeo no feed é publicado como **Reels**; story em vídeo é aceito até 60 s. Instagram não tem publicação privada pela API. Há limite diário de publicações por API (definido pela Meta).
4. Permissões extras via `META_INSTAGRAM_SCOPES` (padrão `instagram_basic,instagram_content_publish`).

## Stories e Metas da semana
- Em **Nova publicação** escolha *Post* ou *Story* (story só no Facebook e no Instagram) e, no post, marque *Postar também como story*. A regra de intervalo mínimo vale **por conta e por tipo**: story não bloqueia post.
- **Metas da semana** (domingo a domingo): por conta e tipo, mostra feito, agendado e o que falta (padrão 1 por semana; editável, 0 desliga) com o atalho *Criar agora*. A contagem é do sistema; o "Plano" do Facebook é calculado pela Meta e pode demorar a refletir, e nada garante que a Meta conte posts feitos por API da mesma forma.
- **Não automatizado de propósito:** anúncio (gasta dinheiro), taxa de resposta (responder mensagens/comentários só para bater meta é automação que as plataformas penalizam) e "acessar insights" (a Meta conta dentro do app dela).

## Estúdio de vídeos
**Configuração (Central de IA):**
1. Provedor **Google Gemini / Veo** (chave do Google AI Studio, com faturamento habilitado para Veo): sincronize os modelos, ative o Veo e informe o **preço por segundo** (sem preço o sistema não gera, para não gastar sem controle).
2. Um provedor OpenAI-compatível (gateway) com modelo de **texto** (ex.: Claude) e de **imagem** (ex.: gpt-image) ativos e com preço. Em *Modelo por tarefa* escolha: *Criar roteiro* e *Legendas e descrições* → texto; *Gerar imagens* → imagem; *Gerar vídeos* → Veo.
3. Vercel Blob (guarda clipes, vídeo final e thumbnail) e o agendador (`CRON_SECRET` + secrets do GitHub), como na publicação.

**Uso:** *Personagens* → criar (descrição fixa + até 3 imagens) → na página do **grupo**, escolher o *Personagem fixo* → *Estúdio de vídeos* → escrever a ideia, escolher o grupo (o personagem do grupo entra sozinho; dá para trocar ou tirar), a duração e o formato → o custo máximo é mostrado e o saldo é conferido antes de começar. A tela acompanha sozinha; o agendador também avança em segundo plano.

**Como funciona:** a duração vira clipes de 4/6/8 s (`VEO_ALLOWED_SECONDS`; 10 s = 8 + 4, depois cortado em 10 s exatos). O mesmo bloco de descrição do personagem entra em **todas** as cenas e na thumbnail, e a primeira imagem de referência é enviada ao Veo como imagem inicial; a thumbnail usa as imagens de referência (se o gateway aceitar `/images/edits`; senão, só o texto). O FFmpeg junta e corta o vídeo. A thumbnail é comprimida para caber nos 2 MB do YouTube.

**Limites honestos:** o Veo não garante o mesmo rosto/roupa entre cenas; a descrição fixa + imagem de referência reduzem a variação, não a eliminam. Cada cena usa seu próprio clipe (sem encadear o último quadro). Vídeos longos custam mais (preço/s × segundos) e levam mais tempo; `STUDIO_MAX_SECONDS` limita (padrão 120). Cenas bloqueadas pelo filtro do Google falham sem cobrança e podem ser refeitas.
