# Contratos de integração

## Gateway de IA
Interface `AIProviderAdapter` (`apps/web/src/server/ai/types.ts`):
- `supports` — mapa modalidade → bool (o roteamento recusa o que o adapter não executa)
- `healthCheck()`, `listModels()`
- `generateText()`, `generateImage()`, `generateSpeech()`
- Vídeo: **ainda não definido na interface**. Quando houver, adicionar `submitVideoJob()` / `getJobStatus()` e executar por worker (chamadas longas e assíncronas).

O catálogo retornado por `listModels()` é a fonte da verdade; nada presume que um gateway ofereça todos os modelos/modalidades.

### Adicionar um adapter
1. Implementar a interface em `src/server/ai/adapters/<nome>.ts` (erros como `ProviderError` com mensagem sanitizada, sem chave).
2. Registrar em `AIAdapterType` (schema Prisma + migration), em `ADAPTER_SUPPORT` e em `createAdapter` (`adapters/index.ts`).
3. Testar com `fetch` simulado (ver `openai-compatible.test.ts`).

### Adapter existente: `OPENAI_COMPATIBLE`
`GET /models`, `POST /chat/completions` (lê `usage` e, se existir, `usage.cost`), `POST /images/generations` (aceita `b64_json` ou `url`), `POST /audio/speech` (mp3). Autenticação `Authorization: Bearer`. Preço no catálogo só é lido quando o provedor envia `pricing.prompt/completion` (USD por token, estilo OpenRouter).

## Roteamento
Ver `ARCHITECTURE.md` → AI Gateway. Cada `AIJob` registra modelo real, modo de seleção, motivo da rota, custo estimado e confirmado, e origem do custo (`REPORTED` / `COMPUTED`).

## Publishers sociais (a implementar)
Interface por plataforma: `validateTarget`, `uploadMedia`, `publish`, `getStatus`. Nunca assumir que Facebook, TikTok e YouTube aceitam o mesmo formato, duração ou mecanismo de agendamento.
