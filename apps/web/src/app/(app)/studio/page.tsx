import { prisma } from '@social-manager/db';
import Link from 'next/link';
import { Flash, type Search } from '@/components/Flash';
import { LocalTime } from '@/components/LocalTime';
import { FORMAT_LABEL } from '@/lib/labels';
import { allowedClipSeconds, maxStudioSeconds } from '@/server/studio/prompts';
import { listProjects, previewVideoPrice } from '@/server/studio/pipeline';
import { getWorkspace } from '@/server/workspace';
import { NewProjectForm } from './NewProjectForm';
import { STATUS } from './status';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // o início do projeto roda depois da resposta

export default async function StudioPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const [projects, groups, characters, video] = await Promise.all([
    listProjects(ws.id),
    prisma.accountGroup.findMany({ where: { workspaceId: ws.id, isActive: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, defaultFormat: true, characterId: true } }),
    prisma.character.findMany({ where: { workspaceId: ws.id }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    previewVideoPrice(ws.id),
  ]);

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Estúdio de vídeos</h1>
          <p>Escreva a ideia. O sistema cria o roteiro em cenas, gera cada cena com o personagem fixo, monta o vídeo na duração pedida e entrega com thumbnail, títulos, descrição, tags e hashtags prontos para publicar.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <div className="card">
        <h3>Novo vídeo</h3>
        <div style={{ marginTop: 12 }}>
          <NewProjectForm
            groups={groups.map((g) => ({ id: g.id, name: g.name, format: g.defaultFormat, characterId: g.characterId }))}
            characters={characters}
            video={video}
            clipSeconds={allowedClipSeconds()}
            maxSeconds={maxStudioSeconds()}
          />
        </div>
      </div>

      <div className="section"><div><h2>Seus vídeos</h2></div></div>
      <div className="card" style={{ padding: 0 }}>
        {projects.length === 0 ? <div className="empty">Nenhum vídeo ainda.</div> : (
          <table>
            <thead><tr><th>Ideia</th><th>Grupo / personagem</th><th>Duração</th><th>Status</th><th>Criado</th></tr></thead>
            <tbody>
              {projects.map((p) => {
                const [label, tone] = STATUS[p.status];
                const done = p.scenes.filter((s) => s.status === 'DONE').length;
                return (
                  <tr key={p.id}>
                    <td><Link href={`/studio/${p.id}`}><strong>{p.selectedTitle ?? p.prompt.slice(0, 70)}</strong></Link></td>
                    <td>{p.group?.name ?? <span className="dim">—</span>}{p.character && <div className="dim" style={{ fontSize: 12 }}>☺ {p.character.name}</div>}</td>
                    <td>{p.targetSeconds}s · {p.aspect}</td>
                    <td><span className={`badge ${tone}`}>{label}</span>{p.status !== 'READY' && p.status !== 'CANCELLED' && <div className="dim" style={{ fontSize: 11 }}>{done}/{p.scenes.length} cenas</div>}</td>
                    <td className="dim"><LocalTime iso={p.createdAt.toISOString()} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="footnote">Formatos: {Object.values(FORMAT_LABEL).slice(0, 2).join(' e ')}. O vídeo é montado com FFmpeg a partir das cenas do Google Veo.</p>
    </>
  );
}
