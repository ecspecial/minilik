import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.collectLoginPairs().length) {
      this.log.warn(
        'Вход отключён: задайте AUTH_LOGIN_USER_1, AUTH_LOGIN_PASS_1, AUTH_LOGIN_USER_2, AUTH_LOGIN_PASS_2',
      );
    }
  }

  /** Две независимые пары логин/пароль (без значений по умолчанию). */
  private collectLoginPairs(): { user: string; pass: string }[] {
    const keys: [string, string][] = [
      ['AUTH_LOGIN_USER_1', 'AUTH_LOGIN_PASS_1'],
      ['AUTH_LOGIN_USER_2', 'AUTH_LOGIN_PASS_2'],
    ];
    const out: { user: string; pass: string }[] = [];
    for (const [userKey, passKey] of keys) {
      const user = this.config.get<string>(userKey)?.trim();
      const passRaw = this.config.get<string>(passKey);
      if (!user || passRaw == null || passRaw === '') continue;
      out.push({ user, pass: passRaw });
    }
    return out;
  }

  login(username: string, password: string) {
    const pairs = this.collectLoginPairs();
    if (!pairs.length) {
      throw new UnauthorizedException('Неверный логин или пароль');
    }
    const u = username.trim();
    const ok = pairs.some((p) => p.user === u && p.pass === password);
    if (!ok) {
      throw new UnauthorizedException('Неверный логин или пароль');
    }
    const accessToken = this.jwt.sign({ sub: u });
    return { accessToken };
  }
}
