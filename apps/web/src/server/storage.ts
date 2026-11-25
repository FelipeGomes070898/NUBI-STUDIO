import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Armazenamento de saídas geradas. Implementação local; trocar por S3 mantendo a interface. */
export interface MediaStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export class LocalMediaStore implements MediaStore {
  private readonly root: string;
  // Na Vercel o disco do projeto é somente leitura e o /tmp é efêmero e por instância:
  // serve para não quebrar, mas NÃO persiste. Para produção, trocar por S3/Blob (interface MediaStore).
  constructor(
    root = process.env.STORAGE_DIR ?? (process.env.VERCEL ? path.join(tmpdir(), 'sm-storage') : path.resolve(process.cwd(), '.data/storage')),
  ) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('Chave de storage inválida.');
    return full;
  }

  async put(key: string, data: Uint8Array) {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.resolve(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
}

export const mediaStore: MediaStore = new LocalMediaStore();
