import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PRODUCT_TYPES } from '../constants/product-types';
import type { SalesChannel } from '../constants/economy-stubs';
import { formatErr, withTiming } from './ai-logger';

const analysisSchemaHint = `Верни ТОЛЬКО валидный JSON без markdown со структурой:
{
  "productType": string — ОДНО из списка типов (точное совпадение строки),
  "season": string,
  "silhouette": string,
  "details": string,
  "materials": string,
  "confidenceNotes": string
}`;

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

  async analyzeProduct(imageDataUrls: string[]): Promise<Record<string, unknown>> {
    const list = PRODUCT_TYPES.join(', ');
    const system = `Ты эксперт по ассортименту одежды. Отвечай на русском. Поле productType — строго одно из: [${list}].`;
    const userContent: OpenAI.Chat.ChatCompletionContentPart[] = [
      { type: 'text', text: `По фото определи изделие. ${analysisSchemaHint}` },
    ];
    for (const url of imageDataUrls) {
      userContent.push({ type: 'image_url', image_url: { url } });
    }
    return this.chatJson('analyzeProduct', system, userContent, {
      imageCount: String(imageDataUrls.length),
    });
  }

  async runConstructor(analysis: Record<string, unknown>): Promise<unknown> {
    const system = `Ты AI-конструктор одежды. Пиши по-русски, профессионально, для производства. Ответ — только JSON:
{
  "constructionDescription": string,
  "cuttingDetails": string,
  "measurementsGuide": string,
  "patternTechBrief": string
}`;
    return this.chatJson('runConstructor', system, [
      { type: 'text', text: `Исходный анализ изделия:\n${JSON.stringify(analysis, null, 2)}` },
    ]);
  }

  async runTechnologist(analysis: Record<string, unknown>): Promise<unknown> {
    const system = `Ты технолог швейного производства. Русский язык. Только JSON:
{
  "stages": string[],
  "equipment": string[],
  "complexNodes": string[],
  "risks": string[]
}`;
    return this.chatJson('runTechnologist', system, [
      { type: 'text', text: `Анализ:\n${JSON.stringify(analysis, null, 2)}` },
    ]);
  }

  async runPurchasing(analysis: Record<string, unknown>): Promise<unknown> {
    const system = `Ты закупщик тканей и фурнитуры. Дай ориентировочные цифры для демо (не оферта). Только JSON:
{
  "fabricDescription": string,
  "hardwareDescription": string,
  "estimatedFabricMeters": number,
  "fabricWastePct": number,
  "estimatedFabricCostRub": number,
  "estimatedHardwareCostRub": number,
  "estimatedProductionCostRub": number,
  "notes": string
}`;
    return this.chatJson('runPurchasing', system, [
      { type: 'text', text: `Анализ:\n${JSON.stringify(analysis, null, 2)}` },
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
    const system =
      'Ты финансовый аналитик маркетплейсов. Кратко на русском (3–6 абзацев): интерпретируй цифры сценариев, риски, что уточнить у заказчика. Не выдумывай новые проценты — ссылайся на уже переданные.';
    const payload = JSON.stringify(input, null, 2);
    this.logger.log(
      `runFinanceNarrative: размер payload ~${payload.length} символов (экономика уже посчитана на бэкенде)`,
    );
    return this.chatText('runFinanceNarrative', system, [
      { type: 'text', text: payload },
    ]);
  }

  async runMarketer(analysis: Record<string, unknown>): Promise<unknown> {
    const system = `Ты маркетолог fashion/e-com. Только JSON:
{
  "seoTitle": string,
  "seoDescription": string,
  "productDescription": string,
  "bullets": string[],
  "positioning": string,
  "advantages": string[]
}`;
    return this.chatJson('runMarketer', system, [
      { type: 'text', text: `Анализ:\n${JSON.stringify(analysis, null, 2)}` },
    ]);
  }

  async runPhotoStudio(analysis: Record<string, unknown>): Promise<unknown> {
    const system = `Ты арт-директор фотосессии для маркетплейса. Только JSON:
{
  "shootBrief": string,
  "angles": string[],
  "infographicIdeas": string[],
  "visualMood": string,
  "lightingAndBackground": string
}
visualMood должен соответствовать именно тому типу изделия из анализа (не «переобувать» комбинезон в куртку).`;
    return this.chatJson('runPhotoStudio', system, [
      { type: 'text', text: `Анализ:\n${JSON.stringify(analysis, null, 2)}` },
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

  private async chatJson(
    operation: string,
    system: string,
    userParts: OpenAI.Chat.ChatCompletionContentPart[],
    extraMeta?: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    return withTiming(`chat:${operation}`, { model: this.model, ...extraMeta }, async () => {
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
          `[${operation}] LOG_VERBOSE_AI превью ответа (400 симв.): ${preview}${content.length > 400 ? '…' : ''}`,
        );
      }

      try {
        return JSON.parse(content) as Record<string, unknown>;
      } catch {
        this.logger.warn(
          `[${operation}] JSON.parse не удался, len=${content.length}`,
        );
        return { parseError: true, raw: content.slice(0, 2000) };
      }
    });
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

      const content = choice?.message?.content ?? '';
      if (this.verboseAi && content) {
        this.logger.log(
          `[${operation}] LOG_VERBOSE_AI превью (400 симв.): ${content.slice(0, 400)}…`,
        );
      }
      return content;
    });
  }
}
