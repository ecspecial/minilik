import { Logger, ValidationPipe, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const debug = process.env.LOG_LEVEL === 'debug';
  const loggerLevels: LogLevel[] = debug
    ? ['error', 'warn', 'log', 'debug', 'verbose']
    : ['error', 'warn', 'log'];

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: loggerLevels,
  });

  const httpLog = new Logger('HTTP');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = req.originalUrl ?? req.url;
    // В Docker иногда видны только стартовые логи Nest; stderr + строка сразу по запросу,
    // чтобы отличить «нет трафика в контейнер» от «буферизация Logger».
    console.error(`[HTTP] -> ${req.method} ${path}`);
    const t0 = Date.now();
    res.on('finish', () => {
      const line = `${req.method} ${path} ${res.statusCode} +${Date.now() - t0}ms`;
      httpLog.log(line);
      console.error(`[HTTP] <- ${line}`);
    });
    next();
  });

  const originRaw = process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173';
  const origin = originRaw.includes(',')
    ? originRaw.split(',').map((s) => s.trim())
    : originRaw;
  app.enableCors({
    origin,
    credentials: true,
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  const boot = new Logger('Bootstrap');
  boot.log(`listening on :${port} (NODE_ENV=${process.env.NODE_ENV ?? ''})`);
}
bootstrap();
