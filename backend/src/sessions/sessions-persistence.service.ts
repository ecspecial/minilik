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
