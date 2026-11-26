/**
 * Lê um stream e devolve pedaços de tamanho EXATO (`sizes`), usando pouca memória (um pedaço por vez).
 * Falha se o stream acabar antes do esperado (arquivo menor que o registrado).
 */
export async function* readExact(stream: ReadableStream<Uint8Array>, sizes: number[]): AsyncGenerator<Buffer> {
  const reader = stream.getReader();
  let buf: Buffer = Buffer.alloc(0);
  try {
    for (const size of sizes) {
      const parts: Uint8Array[] = buf.length ? [buf] : [];
      let have = buf.length;
      buf = Buffer.alloc(0);
      while (have < size) {
        const { done, value } = await reader.read();
        if (done) throw new Error('O arquivo terminou antes do tamanho esperado.');
        parts.push(value);
        have += value.length;
      }
      const all = Buffer.concat(parts);
      yield all.subarray(0, size);
      buf = Buffer.from(all.subarray(size));
    }
  } finally {
    reader.releaseLock();
  }
}
