import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type LogLevel } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const debug = process.env.LOG_LEVEL === 'debug';
  const loggerLevels: LogLevel[] = debug
    ? ['error', 'warn', 'log', 'debug', 'verbose']
    : ['error', 'warn', 'log'];

  const app = await NestFactory.create(AppModule, {
    logger: loggerLevels,
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
}
bootstrap();
