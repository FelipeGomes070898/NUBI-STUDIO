import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ffmpegPath, fitImage, renderFinal } from './render';

const sh = promisify(execFile);
let clip8: Uint8Array;
let clip4: Uint8Array;
let silent: Uint8Array;
let bin = '';

async function makeClip(seconds: number, audio: boolean, size = '720x1280'): Promise<Uint8Array> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fx-'));
  const out = path.join(dir, 'c.mp4');
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=24:duration=${seconds}`, ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-shortest'] : []), out];
  await sh(bin, args);
  const bytes = new Uint8Array(await readFile(out));
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

beforeAll(async () => {
  bin = await ffmpegPath();
  [clip8, clip4, silent] = await Promise.all([makeClip(8, true), makeClip(4, true), makeClip(8, false)]);
});

describe('renderFinal (FFmpeg real)', () => {
  it('une 8s + 4s e corta em 10s exatos, vertical 720x1280', async () => {
    const r = await renderFinal({ clips: [clip8, clip4], targetSeconds: 10 });
    expect(r.seconds).toBeGreaterThanOrEqual(9.9);
    expect(r.seconds).toBeLessThanOrEqual(10.2);
    expect(r).toMatchObject({ width: 720, height: 1280 });
    expect(r.note).toBeUndefined();
    expect(r.bytes.subarray(4, 8).toString()).toBe('ftyp'); // contêiner MP4 válido
  });

  it('vários clipes: 3 × 8s cortados em 20s', async () => {
    const r = await renderFinal({ clips: [clip8, clip8, clip8], targetSeconds: 20 });
    expect(Math.abs(r.seconds - 20)).toBeLessThan(0.3);
  });

  it('o resultado tem áudio quando os clipes têm', async () => {
    const r = await renderFinal({ clips: [clip8], targetSeconds: 6 });
    const dir = await mkdtemp(path.join(tmpdir(), 'fx-'));
    const f = path.join(dir, 'o.mp4');
    await (await import('node:fs/promises')).writeFile(f, r.bytes);
    const log = await sh(bin, ['-hide_banner', '-i', f]).catch((e: { stderr: string }) => e);
    expect((log as { stderr: string }).stderr).toMatch(/Audio: aac/);
    await rm(dir, { recursive: true, force: true });
  });

  it('clipes sem áudio funcionam (vídeo mudo)', async () => {
    const r = await renderFinal({ clips: [silent, silent], targetSeconds: 12 });
    expect(Math.abs(r.seconds - 12)).toBeLessThan(0.3);
  });

  it('se os clipes geraram menos que o pedido, entrega o que tem e avisa', async () => {
    const r = await renderFinal({ clips: [clip4], targetSeconds: 10 });
    expect(r.seconds).toBeLessThan(5);
    expect(r.note).toMatch(/geraram só/);
  });

  it('clipe corrompido falha dizendo qual é (não some em silêncio), sem travar', async () => {
    await expect(renderFinal({ clips: [clip8, new Uint8Array([1, 2, 3, 4, 5])], targetSeconds: 10 })).rejects.toThrow(/O clipe 2 está corrompido/);
    await expect(renderFinal({ clips: [], targetSeconds: 10 })).rejects.toThrow(/Nenhum clipe/);
  });
});

describe('fitImage (thumbnail para o limite de 2 MB do YouTube)', () => {
  async function bigPng(): Promise<Uint8Array> {
    const dir = await mkdtemp(path.join(tmpdir(), 'fx-'));
    const out = path.join(dir, 'big.png');
    await sh(bin, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=1536x1024,noise=alls=100:allf=t+u', '-frames:v', '1', out]);
    const b = new Uint8Array(await readFile(out));
    await rm(dir, { recursive: true, force: true });
    return b;
  }

  it('imagem que já cabe volta intacta', async () => {
    const small = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const r = await fitImage(small, 2 * 1024 * 1024);
    expect(r!.bytes).toBe(small);
    expect(r!.mime).toBe('image/png');
  });

  it('PNG de vários MB vira JPEG de até 2 MB', async () => {
    const big = await bigPng();
    expect(big.length).toBeGreaterThan(2 * 1024 * 1024);
    const r = await fitImage(big, 2 * 1024 * 1024);
    expect(r).not.toBeNull();
    expect(r!.mime).toBe('image/jpeg');
    expect(r!.bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(r!.bytes[0]).toBe(0xff); // cabeçalho JPEG
    expect(r!.bytes[1]).toBe(0xd8);
  });

  it('se nem a qualidade mínima couber, devolve null (o publicador avisa em vez de falhar)', async () => {
    expect(await fitImage(await bigPng(), 1000)).toBeNull();
  });
});
