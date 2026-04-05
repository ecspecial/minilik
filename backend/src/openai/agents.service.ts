import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { ArtifactVersions, IntakeContext } from '../common/artifact-meta';
import {
  CALCULATION_RULES_VERSION,
  SCHEMA_VERSION,
} from '../common/artifact-meta';
import { PRODUCT_TYPES } from '../constants/product-types';
import type { SalesChannel } from '../constants/economy-stubs';
import { normalizeIntakeAnalysis } from './analysis-normalize';
import { formatErr, withTiming } from './ai-logger';
import {
  HUMAN_EDIT_MERGE_SYSTEM,
  JSON_REPAIR_SYSTEM,
  MODULE_RECALCULATION_SYSTEM,
  PROMPT_CONFIG_VERSION as LEGACY_PROMPT_VER,
  withGlobalRules,
} from './prompts/client-prompts';
import {
  BUYER_TEXT_BODY,
  CONSTRUCTOR_STAGE1_BODY,
  CONSTRUCTOR_STAGE2_BODY,
  FINANCE_NARRATIVE_NEW_BODY,
  INTAKE_SYNC_EXTRACT_BODY,
  INTAKE_TEXT_BODY,
  MARKETER_TEXT_BODY,
  MARKET_PRICE_TEXT_BODY,
  PHOTO_TEXT_BODY,
  PATTERN_RENDER_TEXT_BODY,
  PROMPT_CONFIG_VERSION,
  LEKALA_LAYOUT_TEXT_BODY,
  TECHNOLOGIST_TEXT_BODY,
  withNewUpdate,
} from './prompts/new-update-text';

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly verboseAi: boolean;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY пуст — вызовы к API упадут');
    }
    this.client = new OpenAI({ apiKey: apiKey ?? 'missing' });
    this.model = this.config.get<string>('OPENAI_MODEL') ?? 'gpt-5.4';
    this.verboseAi =
      this.config.get<string>('LOG_VERBOSE_AI') === '1' ||
      this.config.get<string>('LOG_VERBOSE_AI') === 'true';
  }

  snapshotArtifactVersions(): ArtifactVersions {
    return {
      prompt_config_version: `${PROMPT_CONFIG_VERSION};legacy=${LEGACY_PROMPT_VER}`,
      schema_version: SCHEMA_VERSION,
      calculation_rules_version: CALCULATION_RULES_VERSION,
      model_version: this.model,
    };
  }

  async analyzeProduct(
    imageDataUrls: string[],
    intakeContext?: IntakeContext | null,
  ): Promise<{ analysis: Record<string, unknown>; report: string }> {
    const system = withNewUpdate(INTAKE_TEXT_BODY);
    const ctx = intakeContext ?? {};
    const userText = `Вход (пустые поля игнорируй):
- brand: ${JSON.stringify(ctx.brand ?? '')}
- collection: ${JSON.stringify(ctx.collection ?? '')}
- user_comment: ${JSON.stringify(ctx.user_comment ?? '')}
- target_channel_hint: ${JSON.stringify(ctx.target_channel_hint ?? '')}
- price_hint: ${JSON.stringify(ctx.price_hint ?? '')}
- age_hint: ${JSON.stringify(ctx.age_hint ?? '')}
- season_hint: ${JSON.stringify(ctx.season_hint ?? '')}
- source_images_count: ${imageDataUrls.length}

Дай отчёт по фото в требуемом порядке разделов.`;

    const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: userText },
    ];
    for (const url of imageDataUrls) {
      userContent.push({ type: 'image_url', image_url: { url } });
    }
    const report = await this.chatText('analyzeProductText', system, userContent);
    const list = PRODUCT_TYPES.join(', ');
    const syncSystem = `${INTAKE_SYNC_EXTRACT_BODY}\n\nВерни только один JSON-объект, без markdown и пояснений.`;
    const raw = await this.chatJson(
      'analyzeProductSync',
      syncSystem,
      [
        {
          type: 'text',
          text: `Список типов (поле productType — ТОЧНО одна строка из этого списка):\n[${list}]\n\nТекст отчёта intake:\n${report}`,
        },
      ],
      { imageCount: String(imageDataUrls.length) },
    );
    return {
      analysis: normalizeIntakeAnalysis(raw),
      report: report.trim(),
    };
  }

  async runConstructorStage1Text(
    masterJson: Record<string, unknown>,
  ): Promise<string> {
    const system = withNewUpdate(CONSTRUCTOR_STAGE1_BODY);
    return this.chatText('runConstructorStage1', system, [
      {
        type: 'text',
        text: `Подтверждённые параметры (master):\n${JSON.stringify(masterJson, null, 2)}\n\nВыполни этап 1 конструктора.`,
      },
    ]);
  }

  async runConstructorStage2Text(
    masterJson: Record<string, unknown>,
    stage1Text: string,
  ): Promise<string> {
    const system = withNewUpdate(CONSTRUCTOR_STAGE2_BODY);
    return this.chatText('runConstructorStage2', system, [
      {
        type: 'text',
        text: `master:\n${JSON.stringify(masterJson, null, 2)}\n\nЭтап 1 (техлист):\n${stage1Text}\n\nВыполни этап 2 — точные лекала.`,
      },
    ]);
  }

  async runTechnologistText(
    masterJson: Record<string, unknown>,
    constructorContext: string,
  ): Promise<string> {
    const system = withNewUpdate(TECHNOLOGIST_TEXT_BODY);
    return this.chatText('runTechnologist', system, [
      {
        type: 'text',
        text: `master:\n${JSON.stringify(masterJson, null, 2)}\n\nКонструктор (текст этапов 1–2):\n${constructorContext}`,
      },
    ]);
  }

  /** Текст только по лекалам (выкройки) — не техрисунок изделия; подписи для image API. */
  async runLekalaLayoutSheetText(
    masterJson: Record<string, unknown>,
    stage1: string,
    stage2: string,
  ): Promise<string> {
    const system = withNewUpdate(LEKALA_LAYOUT_TEXT_BODY);
    const text = await this.chatText('runLekalaLayoutSheet', system, [
      {
        type: 'text',
        text: `master:\n${JSON.stringify(masterJson, null, 2)}\n\nЭтап 1:\n${stage1.slice(0, 12000)}\n\nЭтап 2:\n${stage2.slice(0, 14000)}`,
      },
    ]);
    return text.trim();
  }

  /** Технический рисунок изделия: вид спереди и сзади линиями, без лекал. */
  async generateTechnicalFlatSketchImage(garmentConstructionText: string): Promise<string | null> {
    const spec = garmentConstructionText.slice(0, 10000);
    const prompt = `Children's apparel TECHNICAL FLAT SKETCH only (fashion industry standard).

Draw the FINISHED GARMENT as clean black line art on white background:
- Front view and back view of the same garment (side by side or stacked).
- Show silhouette, seams, pockets, closures, collar or waistband as construction lines.
- No shading, no fabric texture, no photo, no child model, no mannequin.

STRICTLY FORBIDDEN — do NOT draw:
- Flat pattern pieces / sewing pattern templates / lekala shapes laid out for cutting
- Separate sleeve or body panels as for a cutter — those belong on a different document
- Any text, letters, labels, or dimensions on the drawing (line art only)

Follow this construction description for proportions and design:
${spec}`;

    return this.generateOpenAiImage(prompt, {
      operation: 'images.generate.technicalFlat',
      styleSuffix:
        'Pure technical flat sketch, CAD-like clean strokes, white background, no typography.',
      size: '1024x1536',
    });
  }

  async runPurchasingText(
    masterJson: Record<string, unknown>,
    constructorContext: string,
    technologistText: string,
    intakeContext?: IntakeContext | null,
  ): Promise<string> {
    const system = withNewUpdate(BUYER_TEXT_BODY);
    const ic = intakeContext ?? {};
    const hints = `Контекст закупки:
- price_hint: ${ic.price_hint ?? 'нет'}
- user_comment: ${ic.user_comment ?? 'нет'}`;
    return this.chatText('runPurchasing', system, [
      {
        type: 'text',
        text: `master:\n${JSON.stringify(masterJson, null, 2)}\n\nКонструктор:\n${constructorContext.slice(0, 12000)}\n\nТехнолог:\n${technologistText.slice(0, 8000)}\n\n${hints}\n\nСформируй ответ закупщика и блок ###CALC_JSON###.`,
      },
    ]);
  }

  async runFinanceNarrative(input: {
    analysis: Record<string, unknown>;
    purchasing: Record<string, unknown>;
    economyByChannel: Record<
      SalesChannel,
      Record<string, Record<string, unknown>>
    >;
  }): Promise<string> {
    const system = withNewUpdate(FINANCE_NARRATIVE_NEW_BODY);
    const payload = JSON.stringify(input, null, 2);
    this.logger.log(
      `runFinanceNarrative: размер payload ~${payload.length} символов`,
    );
    return this.chatText('runFinanceNarrative', system, [
      {
        type: 'text',
        text: `Данные для интерпретации (расчёты и закупка):\n${payload}`,
      },
    ]);
  }

  async runMarketerText(
    masterJson: Record<string, unknown>,
    constructorContext: string,
    technologistText: string,
    buyerReport: string,
    purchasingCostingJson: string,
    financeNarrative: string,
    economyJson: string,
  ): Promise<string> {
    const system = withNewUpdate(MARKETER_TEXT_BODY);
    return this.chatText('runMarketer', system, [
      {
        type: 'text',
        text: `master:\n${JSON.stringify(masterJson, null, 2)}\n\nКонструктор:\n${constructorContext.slice(0, 10000)}\n\nТехнолог:\n${technologistText.slice(0, 6000)}\n\nЗакупщик (текст):\n${buyerReport.slice(0, 6000)}\n\nСводка cost (JSON для контекста):\n${purchasingCostingJson.slice(0, 4000)}\n\nФинансист (текст):\n${financeNarrative.slice(0, 6000)}\n\nСетки каналов (JSON):\n${economyJson.slice(0, 8000)}`,
      },
    ]);
  }

  async runPhotoStudioText(
    masterJson: Record<string, unknown>,
    marketerText: string,
  ): Promise<string> {
    const system = withNewUpdate(PHOTO_TEXT_BODY);
    return this.chatText('runPhotoStudio', system, [
      {
        type: 'text',
        text: `master:\n${JSON.stringify(masterJson, null, 2)}\n\nМаркетолог:\n${marketerText.slice(0, 10000)}`,
      },
    ]);
  }

  async runModuleRecalculation(input: {
    target_module: string;
    current_master_json: Record<string, unknown>;
    current_module_json: unknown;
    updated_inputs: Record<string, unknown>;
    dependency_context: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const system = withGlobalRules(MODULE_RECALCULATION_SYSTEM);
    return this.chatJson('runModuleRecalculation', system, [
      {
        type: 'text',
        text: `${JSON.stringify(input, null, 2)}\n\nПересчитай только target_module. Верни только JSON.`,
      },
    ]);
  }

  async runHumanEditMerge(input: {
    module_name: string;
    previous_ai_json: unknown;
    user_edits: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const system = withGlobalRules(HUMAN_EDIT_MERGE_SYSTEM);
    return this.chatJson('runHumanEditMerge', system, [
      {
        type: 'text',
        text: `${JSON.stringify(input, null, 2)}\n\nВерни merged_result и merge_warnings. Только JSON.`,
      },
    ]);
  }

  async runJsonRepair(
    broken_json_text: string,
    expected_module: string,
  ): Promise<Record<string, unknown>> {
    const system = withGlobalRules(JSON_REPAIR_SYSTEM);
    return this.chatJsonNoRepair('jsonRepair', system, [
      {
        type: 'text',
        text: `expected_module: ${expected_module}\n\nbroken_json:\n${broken_json_text.slice(0, 14000)}`,
      },
    ]);
  }

  async runPatternRenderInterpreterText(
    masterJson: Record<string, unknown>,
    constructorContext: string,
  ): Promise<string> {
    const system = withNewUpdate(PATTERN_RENDER_TEXT_BODY);
    return this.chatText('runPatternRenderInterpreter', system, [
      {
        type: 'text',
        text: `master:\n${JSON.stringify(masterJson, null, 2)}\n\nКонструктор:\n${constructorContext.slice(0, 14000)}`,
      },
    ]);
  }

  async runMarketPriceEstimateText(input: {
    fabric_candidates: unknown;
    trim_candidates: unknown;
    market_context: unknown;
  }): Promise<string> {
    const system = withNewUpdate(MARKET_PRICE_TEXT_BODY);
    return this.chatText('runMarketPriceEstimate', system, [
      {
        type: 'text',
        text: `Входные данные (ориентиры):\n${JSON.stringify(input, null, 2)}`,
      },
    ]);
  }

  /** Каталожный фотореалистичный кадр изделия (шаг 7 цепочки). */
  async generateGalleryImage(prompt: string): Promise<string | null> {
    return this.generateOpenAiImage(prompt, {
      operation: 'images.generate.gallery',
      styleSuffix:
        'Photorealistic catalog shot, neutral background, no text or watermark.',
    });
  }

  /**
   * Лист ЛЕКАЛ: только плоские детали выкройки для раскроя. Технический рисунок изделия — отдельный вызов (generateTechnicalFlatSketchImage).
   */
  async generatePatternLayoutImage(
    constructorContext: unknown,
    opts?: {
      usePreciseStage2?: boolean;
      /** Подписи только по деталям кроя — runLekalaLayoutSheetText */
      techPackSheetText?: string;
    },
  ): Promise<string | null> {
    const ctx =
      constructorContext !== null && typeof constructorContext === 'object'
        ? JSON.stringify(constructorContext, null, 2)
        : String(constructorContext ?? '');
    const geo = ctx.length > 12000 ? `${ctx.slice(0, 12000)}\n…` : ctx;
    const sheet = (opts?.techPackSheetText ?? '').trim().slice(0, 14000);

    const lekalaDrawingInstructions = `Classic industrial LEKALA / sewing pattern TECHNICAL DRAWING (one sheet, portrait, white background).

WHAT TO DRAW:
- Only flat PATTERN PIECES (2D cutting outlines): seam lines, darts, notches, drilling holes if any.
- Optional grain line: single dashed directional arrow — NO text on the arrow.
- Lay out pieces like a marker / CAD print — clear spacing.

DIMENSIONING — like a real pattern blueprint:
- Use dimension lines with arrowheads (extension lines from piece edges), place ONLY the numeric value between or beside the arrows (Arabic numerals, decimal point OK).
- NO words, NO Cyrillic, NO Latin labels, NO "cm"/"mm", NO piece names, NO title, NO tables — ONLY digits in dimension strings.
- Every important edge length from the schedule below should get a plausible dimension where it fits the geometry.

STRICTLY FORBIDDEN:
- Finished-garment technical flat (front/back fashion sketch of the product on a figure)
- Human, mannequin, photo
- Any typography except lone numbers in dimension chains
- Number-in-circle piece callouts (1, 2, 3 bubbles) — user asked for arrow dimensions only, not part numbers

DIMENSION SCHEDULE & CONTEXT (use numbers for arrows; Russian lines explain placement — never draw that text on the image):
${sheet.length > 0 ? sheet : '(infer key lengths from geometry only)'}

GEOMETRY:
${geo}
---`;

    return this.generateOpenAiImage(lekalaDrawingInstructions, {
      operation: 'images.generate.patternLayout',
      styleSuffix:
        'Technical lekala blueprint: dimension arrows with numeric values only, no words, no Cyrillic, no garment product flat, vector-sharp lines.',
      size: '1024x1536',
    });
  }

  /** Студийный lookbook: образ изделия на модели; тип модели выводить из описания (детский / взрослый и т.д.). */
  async generateStudioLookbookImage(garmentDescription: string): Promise<string | null> {
    const g = garmentDescription.slice(0, 6000);
    const prompt = `Professional fashion e-commerce studio photoshoot (catalog / lookbook).

MODEL — MUST MATCH THE PRODUCT:
Infer one appropriate model from the garment description below (do not default to a child).
- Children's / baby / школьный возраст / детские размеры / рост 98–170 в детском контексте → child or teen model matching that band; natural proportions, neutral expression.
- Women's / men's / adult / missus / unisex adult / размеры взрослого ряда → adult model; match implied gender presentation and build to the silhouette and sizing hints.
- If unclear: use a neutral adult catalog model that fits the garment type.

Outfit: exactly this garment — ${g}

Setting: white or light gray cyclorama, soft even studio lighting (softbox), no harsh shadows.
Layout: single image with a neat grid or trio of views — full body front, full body back or three-quarter, plus one detail of interesting construction — like a lookbook sheet.
Photorealistic, sharp focus, fabric texture visible, catalog quality, no text, no logo, no watermark, no price tag.

Safety: modest commercial apparel only, fully clothed, studio context. For minors: conservative, family-friendly retail styling — no sexualization.`;

    return this.generateOpenAiImage(prompt, {
      operation: 'images.generate.studioLookbook',
      styleSuffix:
        'Premium fashion catalog photography, realistic, model matches garment category, no typography in frame.',
      size: '1024x1536',
    });
  }

  private async generateOpenAiImage(
    prompt: string,
    opts: {
      operation: string;
      styleSuffix: string;
      size?: '1024x1024' | '1024x1536' | '1536x1024' | 'auto';
    },
  ): Promise<string | null> {
    const model = this.config.get<string>('OPENAI_IMAGE_MODEL');
    if (!model) {
      this.logger.log(
        `${opts.operation}: OPENAI_IMAGE_MODEL пуст — генерация пропущена`,
      );
      return null;
    }
    const promptLen = prompt.length;
    const size = opts.size ?? '1024x1024';
    return withTiming(
      opts.operation,
      { model, promptChars: promptLen, size },
      async () => {
        try {
          const img = await this.client.images.generate({
            model,
            prompt: `${prompt}\n\n${opts.styleSuffix}`,
            size,
            n: 1,
          });
          const first = img.data?.[0];
          const url = first?.url;
          if (url) {
            this.logger.log(`${opts.operation}: получен URL`);
            return url;
          }
          const b64 = first?.b64_json;
          if (b64) {
            this.logger.log(
              `${opts.operation}: получен b64, len=${b64.length}`,
            );
            return `data:image/png;base64,${b64}`;
          }
          this.logger.warn(`${opts.operation}: пустой ответ (нет url и b64)`);
          return null;
        } catch (e) {
          this.logger.warn(
            `${opts.operation}: ошибка API: ${formatErr(e)}`,
          );
          return null;
        }
      },
    );
  }

  private async completeChat(
    operation: string,
    system: string,
    userParts: OpenAI.Chat.ChatCompletionContentPart[],
    extraMeta?: Record<string, string>,
  ): Promise<string> {
    return withTiming(`completeChat:${operation}`, { model: this.model, ...extraMeta }, async () => {
      let res: OpenAI.Chat.ChatCompletion;
      try {
        res = await this.client.chat.completions.create({
          model: this.model,
          temperature: 0.35,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userParts },
          ],
        });
      } catch (e) {
        this.logger.error(
          `chat.completions.create [${operation}] ${formatErr(e)}`,
        );
        throw e;
      }

      const choice = res.choices[0];
      const u = res.usage;
      this.logger.log(
        `[${operation}] tokens in=${u?.prompt_tokens ?? '?'} out=${u?.completion_tokens ?? '?'} total=${u?.total_tokens ?? '?'} | finish=${choice?.finish_reason ?? '?'}`,
      );

      const content = choice?.message?.content ?? '{}';
      if (this.verboseAi) {
        const preview = content.slice(0, 400);
        this.logger.log(
          `[${operation}] LOG_VERBOSE_AI превью (400 симв.): ${preview}${content.length > 400 ? '…' : ''}`,
        );
      }
      return content;
    });
  }

  /** Без повторного JSON-repair (для jsonRepair). */
  private async chatJsonNoRepair(
    operation: string,
    system: string,
    userParts: OpenAI.Chat.ChatCompletionContentPart[],
    extraMeta?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const content = await this.completeChat(operation, system, userParts, extraMeta);
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      this.logger.warn(`[${operation}] JSON.parse fail после repair-цепочки`);
      return { parseError: true, raw: content.slice(0, 2000) };
    }
  }

  private async chatJson(
    operation: string,
    system: string,
    userParts: OpenAI.Chat.ChatCompletionContentPart[],
    extraMeta?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const content = await this.completeChat(operation, system, userParts, extraMeta);
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      this.logger.warn(
        `[${operation}] JSON.parse не удался, пробуем jsonRepair, len=${content.length}`,
      );
      try {
        const repaired = await this.runJsonRepair(content, operation);
        if (repaired.parseError === true) {
          return { parseError: true, raw: content.slice(0, 2000) };
        }
        return repaired;
      } catch (e) {
        this.logger.warn(`jsonRepair не помог: ${formatErr(e)}`);
        return { parseError: true, raw: content.slice(0, 2000) };
      }
    }
  }

  private async chatText(
    operation: string,
    system: string,
    userParts: OpenAI.Chat.ChatCompletionContentPart[],
  ): Promise<string> {
    return withTiming(`chatText:${operation}`, { model: this.model }, async () => {
      let res: OpenAI.Chat.ChatCompletion;
      try {
        res = await this.client.chat.completions.create({
          model: this.model,
          temperature: 0.4,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userParts },
          ],
        });
      } catch (e) {
        this.logger.error(
          `chat.completions.create [${operation}] ${formatErr(e)}`,
        );
        throw e;
      }

      const choice = res.choices[0];
      const u = res.usage;
      this.logger.log(
        `[${operation}] tokens in=${u?.prompt_tokens ?? '?'} out=${u?.completion_tokens ?? '?'} total=${u?.total_tokens ?? '?'} | finish=${choice?.finish_reason ?? '?'}`,
      );

      const text = choice?.message?.content ?? '';
      if (this.verboseAi && text) {
        this.logger.log(
          `[${operation}] LOG_VERBOSE_AI превью (400 симв.): ${text.slice(0, 400)}…`,
        );
      }
      return text;
    });
  }
}
