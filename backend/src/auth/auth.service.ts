import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  login(username: string, password: string) {
    const u = this.config.get<string>('DEMO_USER') ?? 'demo';
    const p = this.config.get<string>('DEMO_PASS') ?? 'demo';
    if (username !== u || password !== p) {
      throw new UnauthorizedException('Неверный логин или пароль');
    }
    const accessToken = this.jwt.sign({ sub: username });
    return { accessToken };
  }
}
