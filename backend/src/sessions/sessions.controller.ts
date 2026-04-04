import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { IsBoolean } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SessionsService } from './sessions.service';

class AnalysisDecisionDto {
  @IsBoolean()
  approved!: boolean;
}

@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post()
  create() {
    return this.sessions.create();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.get(id);
  }

  @Post(':id/images')
  @UseInterceptors(FilesInterceptor('files', 3))
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.sessions.attachImages(id, files ?? []);
  }

  @Post(':id/analyze')
  analyze(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.runAnalysis(id);
  }

  @Post(':id/analysis-decision')
  decision(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AnalysisDecisionDto,
  ) {
    return this.sessions.setAnalysisDecision(id, body.approved);
  }

  /** Пошаговая цепочка: шаг 1…5 (шаг 1 сбрасывает предыдущий отчёт). */
  @Post(':id/pipeline/step/:step')
  pipelineStep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('step', ParseIntPipe) step: number,
  ) {
    if (step < 1 || step > 5) {
      throw new BadRequestException('step должен быть от 1 до 5');
    }
    return this.sessions.runPipelineStep(id, step);
  }

  @Post(':id/pipeline')
  pipeline(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.runPipeline(id);
  }
}
