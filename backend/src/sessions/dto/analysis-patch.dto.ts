import { IsOptional, IsString } from 'class-validator';

export class AnalysisPatchDto {
  @IsOptional()
  @IsString()
  productType?: string;

  @IsOptional()
  @IsString()
  season?: string;

  @IsOptional()
  @IsString()
  silhouette?: string;

  @IsOptional()
  @IsString()
  details?: string;

  @IsOptional()
  @IsString()
  materials?: string;

  @IsOptional()
  @IsString()
  confidenceNotes?: string;

  /** Полный текст отчёта intake (промпт new-update §1); показывается пользователю как есть */
  @IsOptional()
  @IsString()
  analysisReport?: string;
}
