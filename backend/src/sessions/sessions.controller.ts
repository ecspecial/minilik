import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AnalysisPatchDto } from './dto/analysis-patch.dto';
import type { IntakeContext } from './sessions.types';
import { SessionsService } from './sessions.service';

class AnalysisDecisionDto {
  @IsBoolean()
  approved!: boolean;
}

class IntakeContextPatchDto implements IntakeContext {
  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  collection?: string;

  @IsOptional()
  @IsString()
  user_comment?: string;

  @IsOptional()
  @IsString()
  target_channel_hint?: string;

  @IsOptional()
  @IsString()
  price_hint?: string;

  @IsOptional()
  @IsString()
  age_hint?: string;

  @IsOptional()
  @IsString()
  season_hint?: string;
}

class RecalculateModuleDto {
  @IsString()
  targetModule!: string;

  @IsOptional()
  @IsObject()
  updatedInputs?: Record<string, unknown>;
}

class MergeModuleDto {
  @IsString()
  module!: string;

  @IsObject()
  userEdits!: Record<string, unknown>;
}

@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post()
  create() {
    return this.sessions.create();
  }

  /** Список сохранённых сессий (метаданные; полное состояние — GET :id). */
  @Get()
  list() {
    return { sessions: this.sessions.listSummaries() };
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.get(id);
  }

  /** §1.2 опциональный контекст до анализа (мержится в сессию). */
  @Patch(':id/intake-context')
  patchIntakeContext(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: IntakeContextPatchDto,
  ) {
    return this.sessions.setIntakeContext(id, body);
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

  /** Правки карточки изделия до подтверждения (и после — только текстовые поля UI). */
  @Patch(':id/analysis')
  patchAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AnalysisPatchDto,
  ) {
    return this.sessions.patchAnalysis(id, body);
  }

  @Post(':id/analysis-decision')
  decision(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AnalysisDecisionDto,
  ) {
    return this.sessions.setAnalysisDecision(id, body.approved);
  }

  /** Пошаговая цепочка: шаг 1…8 (шаг 1 сбрасывает предыдущий отчёт; 8 — финальный пакет). */
  @Post(':id/pipeline/step/:step')
  pipelineStep(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('step', ParseIntPipe) step: number,
  ) {
    if (step < 1 || step > 8) {
      throw new BadRequestException('step должен быть от 1 до 8');
    }
    return this.sessions.runPipelineStep(id, step);
  }

  @Post(':id/pipeline')
  pipeline(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.runPipeline(id);
  }

  /** §9 пересчёт одного модуля по новым входам. */
  @Post(':id/pipeline/recalculate')
  recalculateModule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RecalculateModuleDto,
  ) {
    return this.sessions.recalculateModule(
      id,
      body.targetModule,
      body.updatedInputs,
    );
  }

  /** §11 слияние ручных правок с JSON модуля. */
  @Post(':id/merge-module')
  mergeModule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MergeModuleDto,
  ) {
    return this.sessions.mergeHumanEdits(id, body.module, body.userEdits);
  }

  /** §12 draft-лекала → инструкции рендера (сохраняется в session.pipeline.patternRender). */
  @Post(':id/tools/pattern-render')
  patternRender(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.runPatternRender(id);
  }

  /** Конструктор → изображение лекал (выкройки), не техрисунок изделия. */
  @Post(':id/tools/pattern-layout-image')
  patternLayoutImage(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.runPatternLayoutImage(id);
  }

  /** Технический рисунок изделия (вид спереди/сзади), отдельно от лекал. */
  @Post(':id/tools/technical-flat-image')
  technicalFlatImage(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.runTechnicalFlatImage(id);
  }

  /** Студийный lookbook на модели по карточке изделия (image API; тип модели из описания). */
  @Post(':id/tools/kid-studio-image')
  kidStudioImage(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.runKidStudioImage(id);
  }

  /** Конструктор этап 2 (точные лекала), после шага 1. */
  @Post(':id/constructor-stage-2')
  constructorStage2(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.runConstructorStage2(id);
  }

  /** §13 рыночные ориентиры (ответ без сохранения в сессию). */
  @Post(':id/tools/market-price-estimate')
  marketPriceEstimate(@Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.runMarketPriceHelp(id);
  }
}
