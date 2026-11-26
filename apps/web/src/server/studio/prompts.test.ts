import { describe, expect, it } from 'vitest';
import { captionWithHashtags, characterBlock, extractJson, parseCopy, parsePlan, planDurations, planPrompt, sceneVideoPrompt, thumbPrompt } from './prompts';

const luciano = { name: 'Luciano ZEEN', description: 'Menino de 8 anos, cabelo cacheado castanho, camiseta amarela com raio, tênis vermelho', referenceUrls: [] };

describe('planDurations', () => {
  it('10s → 8 + 4 (o vídeo é cortado em 10s); 30s fecha exato; 8s é um clipe só', () => {
    expect(planDurations(10, [4, 6, 8])).toEqual([8, 4]);
    expect(planDurations(30, [4, 6, 8])).toEqual([8, 8, 8, 6]);
    expect(planDurations(8, [4, 6, 8])).toEqual([8]);
    expect(planDurations(16, [4, 6, 8])).toEqual([8, 8]);
    expect(planDurations(60, [4, 6, 8])).toEqual([8, 8, 8, 8, 8, 8, 8, 4]);
  });
  it('a soma sempre cobre a duração pedida e nunca passa de um clipe a mais', () => {
    for (let t = 1; t <= 120; t++) {
      const d = planDurations(t, [4, 6, 8]);
      const sum = d.reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThanOrEqual(t);
      expect(sum - t).toBeLessThan(4);
      expect(d.every((x) => [4, 6, 8].includes(x))).toBe(true);
    }
  });
  it('modelo que só faz 8s: sempre clipes de 8', () => {
    expect(planDurations(10, [8])).toEqual([8, 8]);
    expect(planDurations(3, [8])).toEqual([8]);
    expect(planDurations(1, [4, 6, 8])).toEqual([4]);
  });
  it('lê VEO_ALLOWED_SECONDS do ambiente', async () => {
    const { allowedClipSeconds } = await import('./prompts');
    process.env.VEO_ALLOWED_SECONDS = '8, 4,x,99';
    expect(allowedClipSeconds()).toEqual([4, 8]);
    process.env.VEO_ALLOWED_SECONDS = 'lixo';
    expect(allowedClipSeconds()).toEqual([4, 6, 8]);
    delete process.env.VEO_ALLOWED_SECONDS;
  });
});

describe('personagem fixo nos prompts', () => {
  it('o mesmo bloco do personagem entra, palavra por palavra, em TODAS as cenas e na thumbnail', () => {
    const block = characterBlock(luciano);
    expect(block).toContain('FIXED CHARACTER "Luciano ZEEN"');
    expect(block).toContain('camiseta amarela com raio');
    const scenes = [0, 1, 2].map((i) => sceneVideoPrompt({ visual: `ação ${i}`, character: luciano, index: i, total: 3 }));
    for (const s of scenes) expect(s).toContain(block);
    expect(thumbPrompt({ title: 'T', character: luciano, scene: 's', aspect: '9:16' })).toContain(block);
    expect(scenes[1]).toContain('continues directly from the previous scene');
    expect(scenes[0]).not.toContain('continues directly');
  });
  it('sem personagem não inventa nada', () => {
    expect(characterBlock(null)).toBe('');
    expect(sceneVideoPrompt({ visual: 'v', character: null, index: 0, total: 1 })).not.toContain('FIXED CHARACTER');
  });
  it('o pedido do roteiro diz quantas cenas e quais durações, e não pede para reescrever o personagem', () => {
    const p = planPrompt({ idea: 'corrida no parque', character: luciano, durations: [8, 8, 4], aspect: '9:16' });
    expect(p.prompt).toContain('EXATAMENTE 3 item');
    expect(p.prompt).toContain('8s, 8s, 4s');
    expect(p.prompt).toContain('vertical 9:16');
    expect(p.prompt).toContain('NÃO reescreva a aparência');
    expect(p.system).toContain('JSON');
  });
});

describe('leitura das respostas da IA', () => {
  it('extrai JSON de cerca de código, de texto em volta e com chaves dentro de strings', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Claro! Aqui está: {"a":{"b":"x } y"}} Espero que ajude.')).toEqual({ a: { b: 'x } y' } });
    expect(() => extractJson('sem json')).toThrow();
    expect(() => extractJson('{"a":')).toThrow();
  });
  it('roteiro: exatamente uma cena por clipe (sobra é cortada, falta é erro)', () => {
    const t = '{"scenes":[{"visual":"a boy runs through the park"},{"visual":"he jumps over a puddle"},{"visual":"he waves at the camera"}]}';
    expect(parsePlan(t, 2)).toEqual(['a boy runs through the park', 'he jumps over a puddle']);
    expect(() => parsePlan(t, 4)).toThrow(/esperado 4/);
    expect(() => parsePlan('{"scenes":[]}', 1)).toThrow();
  });
  it('copy: limpa < >, limita título a 100, tags sem # e ≤500 caracteres, hashtags com # e sem espaço, sem duplicatas', () => {
    const r = parseCopy(JSON.stringify({
      titles: ['A <b>incrível</b> corrida', 'a incrível corrida'.toUpperCase(), 'x'.repeat(150), 'A <b>incrível</b> corrida'],
      description: '  Linha 1\n\nLinha 2  ',
      tags: ['#corrida', 'corrida', 'parque infantil', 'y'.repeat(600)],
      hashtags: ['corrida', '#Corrida Divertida', '#', '#corrida'],
    }));
    expect(r.titles[0]).toBe('A bincrível/b corrida'); // < e > removidos
    expect(r.titles.every((t) => t.length <= 100 && !/[<>]/.test(t))).toBe(true);
    expect(new Set(r.titles).size).toBe(r.titles.length);
    expect(r.tags).toEqual(['corrida', 'parque infantil']); // # removido, duplicada e gigante descartadas
    expect(r.hashtags).toEqual(['#corrida', '#CorridaDivertida']);
    expect(r.description).toBe('Linha 1 Linha 2');
    expect(() => parseCopy('{"titles":[]}')).toThrow();
  });
  it('legenda final = descrição + hashtags', () => {
    expect(captionWithHashtags('Texto', ['#a', '#b'])).toBe('Texto\n\n#a #b');
    expect(captionWithHashtags('', ['#a'])).toBe('#a');
  });
});
