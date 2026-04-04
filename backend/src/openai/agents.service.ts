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
  BUYER_SYSTEM,
  CONSTRUCTOR_SYSTEM,
  FINAL_PACKAGE_ASSEMBLY_SYSTEM,
  FINANCE_CALC_DOC_SYSTEM,
  FINANCE_NARRATIVE_SYSTEM,
  HUMAN_EDIT_MERGE_SYSTEM,
  INTAKE_SYSTEM,
  JSON_REPAIR_SYSTEM,
  MARKETING_SYSTEM,
  MARKET_PRICE_ESTIMATE_SYSTEM,
  MODULE_RECALCULATION_SYSTEM,
  PATTERN_RENDER_INTERPRETER_SYSTEM,
  PHOTO_VISUAL_SYSTEM,
  PROMPT_CONFIG_VERSION,
  TECHNOLOGIST_SYSTEM,
  withGlobalRules,
} from './prompts/client-prompts';

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
      prompt_config_version: PROMPT_CONFIG_VERSION,
      schema_version: SCHEMA_VERSION,
      calculation_rules_version: CALCULATION_RULES_VERSION,
      model_version: this.model,
    };
  }

  async analyzeProduct(
    imageDataUrls: string[],
    intakeContext?: IntakeContext | null,
  ): Promise<Record<string, unknown>> {
    const list = PRODUCT_TYPES.join(', ');
    const system = withGlobalRules(INTAKE_SYSTEM);
    const ctx = intakeContext ?? {};
    const userText = `Закрытый справочник типов (vision_summary.product_type — ТОЧНО одна строка из списка):
[${list}]

Вход (как в ТЗ §1.2; пустые строки игнорируй):
- brand: ${JSON.stringify(ctx.brand ?? '')}
- collection: ${JSON.stringify(ctx.collection ?? '')}
- user_comment: ${JSON.stringify(ctx.user_comment ?? '')}
- target_channel_hint: ${JSON.stringify(ctx.target_channel_hint ?? '')}
- price_hint: ${JSON.stringify(ctx.price_hint ?? '')}
- age_hint: ${JSON.stringify(ctx.age_hint ?? '')}
- season_hint: ${JSON.stringify(ctx.season_hint ?? '')}
- source_images_count: ${imageDataUrls.length}

Создай initial SKU hypothesis по фото. При конфликте фото vs текст — укажи в JSON. Верни только JSON по схеме из system.`;

    const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: userText },
    ];
    for (const url of imageDataUrls) {
      userContent.push({ type: 'image_url', image_url: { url } });
    }
    const raw = await this.chatJson('analyzeProduct', system, userContent, {
      imageCount: String(imageDataUrls.length),
    });
    return normalizeIntakeAnalysis(raw);
  }

  async runConstructor(
    masterJson: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const system = withGlobalRules(CONSTRUCTOR_SYSTEM);
    return this.chatJson('runConstructor', system, [
      {
        type: 'text',
        text: `master_json:\n${JSON.stringify(masterJson, null, 2)}\n\nСформируй предварительное конструкторское решение и draft-лекала. Верни только JSON.`,
      },
    ]);
  }

  async runTechnologist(
    masterJson: Record<string, unknown>,
    constructorJson: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const system = withGlobalRules(TECHNOLOGIST_SYSTEM);
    return this.chatJson('runTechnologist', system, [
      {
        type: 'text',
        text: `master_json:\n${JSON.stringify(masterJson, null, 2)}\n\nconstructor_json:\n${JSON.stringify(constructorJson, null, 2)}\n\nСформируй технологическую карту. Верни только JSON.`,
      },
    ]);
  }

  async runPurchasing(
    masterJson: Record<string, unknown>,
    constructorJson: Record<string, unknown>,
    technologistJson: Record<string, unknown>,
    intakeContext?: IntakeContext | null,
  ): Promise<Record<string, unknown>> {
    const system = withGlobalRules(BUYER_SYSTEM);
    const ic = intakeContext ?? {};
    const placeholders = {
      provided_material_prices: ic.price_hint
        ? { note: ic.price_hint, source: 'user_hint' }
        : {},
      provided_trim_prices: {},
      market_price_context: ic.price_hint
        ? String(ic.price_hint)
        : 'не передан — используй осторожные estimated_market ориентиры',
      width_and_density_context: 'не передан',
    };
    return this.chatJson('runPurchasing', system, [
      {
        type: 'text',
        text: `master_json:\n${JSON.stringify(masterJson, null, 2)}\n\nconstructor_json:\n${JSON.stringify(constructorJson, null, 2)}\n\ntechnologist_json:\n${JSON.stringify(technologistJson, null, 2)}\n\nКонтекст цен и подсказок:\n${JSON.stringify(placeholders, null, 2)}\n\nСформируй buyer_json. Верни только JSON.`,
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
    const system = withGlobalRules(FINANCE_NARRATIVE_SYSTEM);
    const payload = JSON.stringify(input, null, 2);
    this.logger.log(
      `runFinanceNarrative: размер payload ~${payload.length} символов`,
    );
    return this.chatText('runFinanceNarrative', system, [
      { type: 'text', text: payload },
    ]);
  }

  /** §5 структурированный finance-json поверх данных бэкенда */
  async runFinanceCalculationDoc(input: {
    master_json: Record<string, unknown>;
    buyer_json: Record<string, unknown>;
    material_cost_summary: {
      fabricCost: number;
      hardwareCost: number;
      productionCost: number;
    };
    economy_by_channel: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const system = withGlobalRules(FINANCE_CALC_DOC_SYSTEM);
    return this.chatJson('runFinanceCalculationDoc', system, [
      {
        type: 'text',
        text: `${JSON.stringify(input, null, 2)}\n\nОформи ответ по схеме. Числа full_cost и помесячные итоги должны соответствовать переданным расчётам.`,
      },
    ]);
  }

  async runMarketer(
    masterJson: Record<string, unknown>,
    constructorJson: Record<string, unknown>,
    technologistJson: Record<string, unknown>,
    buyerJson: Record<string, unknown>,
    financeJson: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const system = withGlobalRules(MARKETING_SYSTEM);
    return this.chatJson('runMarketer', system, [
      {
        type: 'text',
        text: `master_json:\n${JSON.stringify(masterJson, null, 2)}\n\nconstructor_json:\n${JSON.stringify(constructorJson, null, 2)}\n\ntechnologist_json:\n${JSON.stringify(technologistJson, null, 2)}\n\nbuyer_json:\n${JSON.stringify(buyerJson, null, 2)}\n\nfinance_json:\n${JSON.stringify(financeJson, null, 2)}\n\nСформируй маркетинговый пакет. Верни только JSON.`,
      },
    ]);
  }

  async runPhotoStudio(
    masterJson: Record<string, unknown>,
    marketingJson: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const system = withGlobalRules(PHOTO_VISUAL_SYSTEM);
    return this.chatJson('runPhotoStudio', system, [
      {
        type: 'text',
        text: `master_json:\n${JSON.stringify(masterJson, null, 2)}\n\nmarketing_json:\n${JSON.stringify(marketingJson, null, 2)}\n\nСформируй визуальный пакет промптов. Верни только JSON.`,
      },
    ]);
  }

  async runFinalPackageAssembly(input: {
    master_json: Record<string, unknown>;
    constructor_json: unknown;
    technologist_json: unknown;
    buyer_json: unknown;
    finance_json: unknown;
    marketing_json: unknown;
    photo_json: unknown;
    generated_image_url: string | null | undefined;
  }): Promise<Record<string, unknown>> {
    const system = withGlobalRules(FINAL_PACKAGE_ASSEMBLY_SYSTEM);
    return this.chatJson('runFinalPackageAssembly', system, [
      {
        type: 'text',
        text: `${JSON.stringify(input, null, 2)}\n\nСобери финальный SKU package. В overview включи ссылку на изображение, если есть. Верни только JSON.`,
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

  async runPatternRenderInterpreter(
    masterJson: Record<string, unknown>,
    constructorJson: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const system = withGlobalRules(PATTERN_RENDER_INTERPRETER_SYSTEM);
    return this.chatJson('runPatternRenderInterpreter', system, [
      {
        type: 'text',
        text: `master_json:\n${JSON.stringify(masterJson, null, 2)}\n\nconstructor_json:\n${JSON.stringify(constructorJson, null, 2)}`,
      },
    ]);
  }

  async runMarketPriceEstimate(input: {
    fabric_candidates: unknown;
    trim_candidates: unknown;
    market_context: unknown;
  }): Promise<Record<string, unknown>> {
    const system = withGlobalRules(MARKET_PRICE_ESTIMATE_SYSTEM);
    return this.chatJson('runMarketPriceEstimate', system, [
      { type: 'text', text: JSON.stringify(input, null, 2) },
    ]);
  }

  async generateGalleryImage(prompt: string): Promise<string | null> {
    const model = this.config.get<string>('OPENAI_IMAGE_MODEL');
    if (!model) {
      this.logger.log('generateGalleryImage: OPENAI_IMAGE_MODEL пуст — шаг пропущен');
      return null;
    }
    const promptLen = prompt.length;
    return withTiming(
      'images.generate',
      { model, promptChars: promptLen },
      async () => {
        try {
          const img = await this.client.images.generate({
            model,
            prompt: `${prompt}\n\nPhotorealistic catalog shot, neutral background, no text or watermark.`,
            size: '1024x1024',
            n: 1,
          });
          const first = img.data?.[0];
          const url = first?.url;
          if (url) {
            this.logger.log('images.generate: получен URL');
            return url;
          }
          const b64 = first?.b64_json;
          if (b64) {
            this.logger.log(
              `images.generate: получен b64, len=${b64.length}`,
            );
            return `data:image/png;base64,${b64}`;
          }
          this.logger.warn('images.generate: пустой ответ (нет url и b64)');
          return null;
        } catch (e) {
          this.logger.warn(
            `images.generate: ошибка API (цепочка продолжится без картинки): ${formatErr(e)}`,
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
