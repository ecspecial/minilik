import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import * as multer from 'multer';
import { AuthModule } from './auth/auth.module';
import { SessionsModule } from './sessions/sessions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MulterModule.register({
      storage: multer.memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024 },
    }),
    AuthModule,
    SessionsModule,
  ],
})
export class AppModule {}
