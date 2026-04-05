import { Module } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { SessionsPersistenceService } from './sessions-persistence.service';
import { OpenAiModule } from '../openai/openai.module';

@Module({
  imports: [OpenAiModule],
  controllers: [SessionsController],
  providers: [SessionsPersistenceService, SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
