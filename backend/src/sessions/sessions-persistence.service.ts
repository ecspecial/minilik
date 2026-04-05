import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync } from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { SessionState } from './sessions.types';

function resolveWritableSessionsDir(
  preferred: string,
  log: Logger,
): string {
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EACCES' || err.code === 'EROFS') {
      const fallback = path.join(tmpdir(), 'minilik-sessions');
      log.warn(
        `Нет права записи в ${preferred} (${err.code}). Используется ${fallback}. Для постоянных сессий задайте SESSIONS_DATA_DIR на смонтированный том или обновите образ (mkdir /app/data в Dockerfile).`,
      );
      mkdirSync(fallback, { recursive: true });
      return fallback;
    }
    throw e;
  }
}

@Injectable()
export class SessionsPersistenceService implements OnModuleInit {
  private readonly log = new Logger(SessionsPersistenceService.name);
  readonly dir: string;

  constructor(private readonly config: ConfigService) {
    const preferred =
      this.config.get<string>('SESSIONS_DATA_DIR')?.trim() ||
      path.join(process.cwd(), 'data', 'sessions');
    this.dir = resolveWritableSessionsDir(preferred, this.log);
  }

  async onModuleInit(): Promise<void> {
    this.log.log(`каталог сессий: ${this.dir}`);
  }

  private filePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  /** Каталог бинарных снимков сессии: `{dataDir}/images/{sessionId}/{0,1,2}`. */
  sessionImagesDir(sessionId: string): string {
    return path.join(this.dir, 'images', sessionId);
  }

  async clearSessionImages(sessionId: string): Promise<void> {
    const dir = this.sessionImagesDir(sessionId);
    try {
      const names = await fs.readdir(dir);
      await Promise.all(
        names.map((n) => fs.unlink(path.join(dir, n)).catch(() => undefined)),
      );
    } catch {
      /* каталога ещё нет */
    }
  }

  async writeSessionImage(
    sessionId: string,
    index: number,
    buffer: Buffer,
    _mime: string,
  ): Promise<void> {
    const dir = this.sessionImagesDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${index}`);
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, filePath);
  }

  async readSessionImage(sessionId: string, index: number): Promise<Buffer | null> {
    const filePath = path.join(this.sessionImagesDir(sessionId), `${index}`);
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }

  /** Каталог артефактов pipeline: раскладка лекал, техрисунок, lookbook и т.д. */
  pipelineDir(sessionId: string): string {
    return path.join(this.sessionImagesDir(sessionId), 'pipeline');
  }

  async writePipelineImage(
    sessionId: string,
    kind: string,
    buffer: Buffer,
    mime: string,
  ): Promise<void> {
    const dir = this.pipelineDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const base = path.join(dir, kind);
    const tmp = `${base}.tmp`;
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, base);
    const mimePath = `${base}.mime`;
    const mtmp = `${mimePath}.tmp`;
    await fs.writeFile(mtmp, (mime || 'image/png').split(';')[0].trim(), 'utf8');
    await fs.rename(mtmp, mimePath);
  }

  async readPipelineImage(
    sessionId: string,
    kind: string,
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const base = path.join(this.pipelineDir(sessionId), kind);
    try {
      const buffer = await fs.readFile(base);
      let mimeType = 'image/png';
      try {
        const m = await fs.readFile(`${base}.mime`, 'utf8');
        const t = m.trim();
        if (t) mimeType = t;
      } catch {
        /* только бинарник — дефолт png */
      }
      return { buffer, mimeType };
    } catch {
      return null;
    }
  }

  async clearPipelineImages(sessionId: string): Promise<void> {
    const dir = this.pipelineDir(sessionId);
    try {
      const names = await fs.readdir(dir);
      await Promise.all(
        names.map((n) => fs.unlink(path.join(dir, n)).catch(() => undefined)),
      );
      await fs.rmdir(dir);
    } catch {
      /* каталога нет */
    }
  }

  async save(state: SessionState): Promise<void> {
    const p = this.filePath(state.id);
    const tmp = `${p}.tmp`;
    const payload = JSON.stringify(state);
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, p);
  }

  async loadAll(): Promise<SessionState[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const out: SessionState[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
      const full = path.join(this.dir, name);
      try {
        const raw = await fs.readFile(full, 'utf8');
        const s = JSON.parse(raw) as SessionState;
        if (s?.id && typeof s.id === 'string') out.push(s);
      } catch (e) {
        this.log.warn(`пропуск файла ${name}: ${String(e)}`);
      }
    }
    return out;
  }
}
