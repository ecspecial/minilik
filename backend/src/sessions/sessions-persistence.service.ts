import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { SessionState } from './sessions.types';

@Injectable()
export class SessionsPersistenceService implements OnModuleInit {
  private readonly log = new Logger(SessionsPersistenceService.name);
  private readonly dir: string;

  constructor(private readonly config: ConfigService) {
    this.dir =
      this.config.get<string>('SESSIONS_DATA_DIR')?.trim() ||
      path.join(process.cwd(), 'data', 'sessions');
  }

  async onModuleInit(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
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
