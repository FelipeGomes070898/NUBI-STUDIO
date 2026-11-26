import Link from 'next/link';
import { Flash, type Search } from '@/components/Flash';
import { ConfirmButton } from '@/components/ConfirmButton';
import { listCharacters } from '@/server/studio/characters';
import { getWorkspace } from '@/server/workspace';
import { deleteCharacterAction } from './actions';
import { CharacterForm } from './CharacterForm';

export const dynamic = 'force-dynamic';

export default async function CharactersPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const characters = await listCharacters(ws.id);
  const blobReady = !!process.env.BLOB_READ_WRITE_TOKEN;

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Personagens</h1>
          <p>O personagem fixo de uma marca. Cadastre uma vez, fixe no grupo (na página do grupo) e ele aparece igual em todos os vídeos criados no Estúdio: a descrição entra em todas as cenas e a imagem guia o vídeo e a thumbnail.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <div className="card">
        <h3>Novo personagem</h3>
        <div style={{ marginTop: 12 }}><CharacterForm blobReady={blobReady} /></div>
      </div>

      <div className="section"><div><h2>{characters.length} personagem(ns)</h2></div></div>
      {characters.length === 0 ? <div className="card empty">Nenhum personagem ainda.</div> : characters.map((c) => (
        <div className="card" key={c.id} style={{ marginBottom: 14 }}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} className="noflex">
              {c.referenceUrls.length === 0 && <div className="dim" style={{ fontSize: 12 }}>sem imagem</div>}
              {c.referenceUrls.map((u) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={u} src={u} alt={c.name} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--line)' }} />
              ))}
            </div>
            <div>
              <h3>{c.name}</h3>
              <p style={{ margin: '4px 0', fontSize: 13 }}>{c.description}</p>
              <div style={{ fontSize: 12 }}>
                {c.groups.length ? <>Fixo em: {c.groups.map((g) => <Link key={g.id} href={`/groups/${g.id}`} className="badge">{g.name}</Link>)}</> : <span className="dim">Não está fixo em nenhum grupo (fixe na página do grupo).</span>}
                <span className="dim"> · {c._count.projects} vídeo(s)</span>
              </div>
            </div>
          </div>
          <details>
            <summary>Editar</summary>
            <CharacterForm initial={{ id: c.id, name: c.name, description: c.description, referenceUrls: c.referenceUrls }} blobReady={blobReady} />
            <form action={deleteCharacterAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="entityId" value={c.id} />
              <ConfirmButton className="danger small" message={`Excluir "${c.name}"? Os grupos que o usam ficam sem personagem fixo.`}>Excluir personagem</ConfirmButton>
            </form>
          </details>
        </div>
      ))}
    </>
  );
}
